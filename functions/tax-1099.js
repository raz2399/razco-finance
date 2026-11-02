// Netlify Function: tax-1099
// Who has to be sent a 1099-NEC, and for how much.
//
// Route: /.netlify/functions/tax-1099
//   GET  ?store_id=store1&year=2026   -> the report and the candidates
//   POST { vendor_id, is_1099, w9_on_file }  -> record a decision
//
// ---------------------------------------------------------------------
// Why this exists
//
// The forms are due 31 January and the penalty for missing one runs from
// $60 to $340 per form depending on how late it is. The information
// needed is total paid per person per calendar year, which this system
// already holds to the cent and which Raz currently has no way to see.
//
// ---------------------------------------------------------------------
// What is NOT reportable, and why each exclusion is here
//
// Getting this wrong in the generous direction means sending forms to
// 180 grocery distributors who neither need nor expect one. So:
//
//   goods            A 1099-NEC reports payment for SERVICES. Buying
//                    $700,000 of groceries from a wholesaler is not a
//                    service, and no form is owed however large it is.
//                    Everything categorised as Merchandise is out.
//
//   card payments    If it was paid by card, the card network files a
//                    1099-K and the payer must not also report it, or
//                    the same income is reported to the IRS twice
//                    against that person. Only check, ACH, cash and
//                    wire count here.
//
//   under $600       The threshold is $600 for the calendar year, per
//                    payee, in aggregate -- not per invoice.
//
//   corporations     Payments to a corporation are generally exempt,
//                    with real exceptions including attorneys. The
//                    system cannot tell a corporation from an LLC by
//                    its name, so it does NOT try: it shows who crossed
//                    the threshold and Raz marks who actually gets one.
//
// That last point is the shape of this whole endpoint. It does the
// arithmetic, which it can do perfectly, and it leaves the judgement to
// a person, because the judgement needs facts about each vendor that are
// not in this database and cannot be inferred from a name.
//
// This is a report, not tax advice. It says so in the reply.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The threshold, and the methods that count. Both are here rather than
// inline so that when the IRS changes the figure, it changes in one place.
const THRESHOLD = 600;
const REPORTABLE_METHODS = ['check', 'ach', 'cash', 'wire'];

const BUSINESS_TZ = 'America/Los_Angeles';
const pacificToday = () => new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });

async function all(table, columns, build) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns).range(from, from + PAGE - 1);
    q = build(q);
    const res = await q;
    if (res.error) throw new Error(table + ': ' + res.error.message);
    const got = res.data || [];
    rows.push.apply(rows, got);
    if (got.length < PAGE) return rows;
    if (rows.length > 100000) return rows;
  }
}

exports.handler = safely('tax-1099', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { body = {}; }
  }
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  // ---------------- record a decision ---------------------------------
  if (event.httpMethod === 'POST') {
    const vendor_id = body.vendor_id;
    if (!vendor_id) return json(400, { error: 'Which vendor?' });

    const patch = { updated_at: new Date().toISOString() };
    if (body.is_1099 !== undefined) patch.is_1099 = !!body.is_1099;
    if (body.w9_on_file !== undefined) patch.w9_on_file = !!body.w9_on_file;
    if (Object.keys(patch).length === 1) {
      return json(400, { error: 'Nothing to change.' });
    }

    const res = await supabase
      .from('vendors')
      .update(patch)
      .eq('vendor_id', vendor_id)
      .eq('store_id', store_id)
      .select('vendor_id, name, is_1099, w9_on_file');
    if (res.error) return json(500, { error: res.error.message });
    const row = (res.data || [])[0];
    if (!row) return json(404, { error: 'No such vendor.' });

    return json(200, {
      ok: true,
      vendor: row,
      message: row.name + (row.is_1099 ? ' gets a 1099.' : ' does not get a 1099.')
        + (row.is_1099 && !row.w9_on_file ? ' No W-9 on file yet.' : ''),
    });
  }

  // ---------------- the report -----------------------------------------
  const year = Number(q.year || body.year || pacificToday().slice(0, 4));
  if (!(year > 2000 && year < 2100)) return json(400, { error: 'Which year?' });

  const from = year + '-01-01';
  const to = year + '-12-31';

  const [payments, vendors, cats] = await Promise.all([
    all('payments', 'payment_id, vendor_id, amount, payment_date, method, status',
      (p) => p.eq('store_id', store_id)
        .gte('payment_date', from).lte('payment_date', to)),
    all('vendors', 'vendor_id, name, default_category_id, is_1099, w9_on_file, payment_type',
      (p) => p.eq('store_id', store_id)),
    all('expense_categories', 'category_id, name, ledger_type',
      (p) => p.eq('store_id', store_id)),
  ]);

  const vendorById = {};
  vendors.forEach((v) => { vendorById[v.vendor_id] = v; });

  // Which categories are goods rather than services.
  const isGoods = {};
  cats.forEach((c) => {
    if (c.ledger_type === 'cogs' || /merchandise|freight/i.test(c.name)) {
      isGoods[c.category_id] = true;
    }
  });

  // Total per vendor, counting only what is actually reportable.
  const totals = {};
  let skippedCard = 0;
  let skippedVoid = 0;
  payments.forEach((p) => {
    if (!p.vendor_id) return;
    if (p.status === 'void' || p.status === 'stopped') { skippedVoid += 1; return; }
    if (REPORTABLE_METHODS.indexOf(p.method) === -1) { skippedCard += 1; return; }

    const t = totals[p.vendor_id] || (totals[p.vendor_id] = {
      vendor_id: p.vendor_id, paid: 0, payments: 0,
    });
    t.paid = money(t.paid + Math.abs(money(p.amount)));
    t.payments += 1;
  });

  const rows = Object.keys(totals).map((id) => {
    const t = totals[id];
    const v = vendorById[id] || {};
    return {
      vendor_id: id,
      name: v.name || '(unnamed)',
      paid: t.paid,
      payments: t.payments,
      is_1099: !!v.is_1099,
      w9_on_file: !!v.w9_on_file,
      category_id: v.default_category_id || null,
      goods: !!isGoods[v.default_category_id],
      over_threshold: t.paid >= THRESHOLD,
    };
  }).sort((a, b) => b.paid - a.paid);

  // Already decided: these get a form.
  const reportable = rows.filter((r) => r.is_1099);

  // Not decided, but crossed the line and is not obviously goods. These
  // are the ones to look at, and nothing more is claimed about them.
  const candidates = rows.filter((r) => !r.is_1099 && r.over_threshold && !r.goods);

  // Marked for a form, over the threshold, and no W-9. This is the list
  // that actually stops the filing happening, so it is counted on its own.
  const missingW9 = reportable.filter((r) => r.over_threshold && !r.w9_on_file);

  // Marked for a form but under $600 this year: no form owed.
  const underThreshold = reportable.filter((r) => !r.over_threshold);

  const due = (year + 1) + '-01-31';

  return json(200, {
    ok: true,
    year: year,
    forms_due: due,
    threshold: THRESHOLD,
    counted_methods: REPORTABLE_METHODS,
    summary: {
      forms_to_file: reportable.filter((r) => r.over_threshold).length,
      total_reportable: money(reportable
        .filter((r) => r.over_threshold)
        .reduce((s, r) => s + r.paid, 0)),
      missing_w9: missingW9.length,
      to_review: candidates.length,
      marked_but_under_threshold: underThreshold.length,
      payments_excluded_as_card: skippedCard,
      payments_excluded_as_void: skippedVoid,
    },
    reportable: reportable,
    candidates: candidates,
    missing_w9: missingW9,
    notes: [
      'Only check, ACH, cash and wire are counted. Anything paid by card is '
        + 'reported by the card network on a 1099-K, and reporting it here too '
        + 'would report the same income twice against that person.',
      'Merchandise and freight are left out: a 1099-NEC is for services, so '
        + 'buying goods does not need one however large the figure.',
      'Payments to corporations are generally exempt, with exceptions such as '
        + 'attorneys. Nothing here can tell a corporation from an LLC by its '
        + 'name, so the candidates are who crossed $600 -- you decide who '
        + 'actually gets a form.',
      'This is a report built from your own payment records, not tax advice. '
        + 'Your accountant should see it before anything is filed.',
    ],
  });
});

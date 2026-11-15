// Credits: the short delivery, the damaged pallet, the wrong price.
//
// ---------------------------------------------------------------------
// The two kinds, because they behave differently
//
// Against a bill. Twelve cases billed, ten delivered. The invoice still
// says what the paper says — he photographs these, and the figure on the
// paper is the evidence he would argue with the vendor from — so the
// credit sits beside it in invoices.credit_amount and what he owes is
// the arithmetic of the three. Pay the reduced figure and the bill is
// closed.
//
// On account. A credit memo arrives for damage on a delivery already
// paid. Nothing to reduce, so it waits in vendor_credits until the next
// check to that vendor, and comes off it.
//
// ---------------------------------------------------------------------
// What a credit must never become
//
// A payment. Recording it as one would say money left the bank when it
// did not, and the bank feed would spend the rest of its life hunting a
// cleared item that does not exist.
//
// A quiet edit to the invoice total. That would make the books disagree
// with the photograph, which destroys the only use a credit record
// really has: proving to a vendor what was short.

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
const dollars = (n) => '$' + money(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const OPEN = ['approved', 'scheduled', 'partially_paid'];

// Why money is coming back. Kept short because he is standing at a
// delivery door with a driver waiting.
const REASONS = {
  short: 'Short delivery',
  damaged: 'Damaged or spoiled',
  overcharge: 'Charged the wrong price',
  returned: 'Returned',
  other: 'Other',
};

function pacificToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/**
 * Does this database count credits in what is owed yet?
 *
 * balance_due is generated, and the migration that teaches it about
 * credit_amount has to drop and rebuild the column. Until that has run,
 * writing a credit against a bill would record it and change nothing
 * about what the bill says is owed -- the worst of both, because he
 * would short-pay against a figure that had not moved and the bill
 * would sit open for the difference.
 *
 * So it is asked rather than assumed, once per cold start.
 */
let countsCredits = null;
async function creditsCount() {
  if (countsCredits !== null) return countsCredits;
  try {
    const probe = await supabase.from('invoices')
      .select('invoice_id, total_amount, amount_paid, credit_amount, balance_due')
      .limit(1).maybeSingle();
    if (probe.error || !probe.data) { countsCredits = false; return countsCredits; }
    const r = probe.data;
    const withCredit = money(r.total_amount) - money(r.amount_paid) - money(r.credit_amount);
    const without = money(r.total_amount) - money(r.amount_paid);
    // When nothing is credited yet the two agree, so the only safe read
    // is whether the column exists at all and the balance is consistent.
    countsCredits = money(r.balance_due) === money(withCredit)
      && (money(r.credit_amount) !== 0 || money(withCredit) === money(without));
  } catch (e) {
    countsCredits = false;
  }
  return countsCredits;
}

exports.handler = safely('credits', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  // ---- what is open ----------------------------------------------------
  if (event.httpMethod === 'GET') {
    const [credits, vendors] = await Promise.all([
      supabase.from('vendor_credits')
        .select('credit_id, vendor_id, credit_date, amount, reason, note, status, invoice_id, applied_at')
        .eq('store_id', store_id).order('credit_date', { ascending: false }).limit(100),
      supabase.from('vendors').select('vendor_id, name')
        .eq('store_id', store_id).eq('active', true).order('name'),
    ]);

    // The table may not exist yet on an older database.
    if (credits.error) {
      return json(200, {
        ok: true, credits: [], open_total: 0,
        vendors: (vendors.data || []),
        reasons: Object.keys(REASONS).map((k) => ({ key: k, name: REASONS[k] })),
        says: 'Credits are not set up on this database yet.',
      });
    }

    const vName = {};
    (vendors.data || []).forEach((v) => { vName[v.vendor_id] = v.name; });

    const rows = (credits.data || []).map((c) => ({
      credit_id: c.credit_id,
      vendor_id: c.vendor_id,
      vendor: vName[c.vendor_id] || null,
      date: c.credit_date,
      amount: money(c.amount),
      reason: REASONS[c.reason] || c.reason || null,
      note: c.note || null,
      status: c.status,
      invoice_id: c.invoice_id,
    }));
    const open = rows.filter((r) => r.status === 'open');
    const openTotal = money(open.reduce((t, r) => t + r.amount, 0));

    return json(200, {
      ok: true,
      credits: rows,
      open_count: open.length,
      open_total: openTotal,
      vendors: (vendors.data || []),
      reasons: Object.keys(REASONS).map((k) => ({ key: k, name: REASONS[k] })),
      counts_in_balances: await creditsCount(),
      says: open.length
        ? dollars(openTotal) + ' owed back to you across ' + open.length
          + ' credit' + (open.length === 1 ? '' : 's') + '.'
        : 'No credits outstanding.',
    });
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Use GET or POST.' });

  // ---- taking one back -------------------------------------------------
  if (body.action === 'void') {
    if (!body.credit_id) return json(400, { error: 'Which credit?' });
    const was = await supabase.from('vendor_credits')
      .select('credit_id, invoice_id, amount, status')
      .eq('credit_id', body.credit_id).eq('store_id', store_id).maybeSingle();
    if (was.error) return json(500, { error: was.error.message });
    if (!was.data) return json(404, { error: 'No such credit.' });
    if (was.data.status === 'applied') {
      return json(409, {
        error: 'That credit has already come off a check, so voiding it here '
          + 'would leave the check short by ' + dollars(was.data.amount) + '.',
      });
    }

    // A credit against a bill has to be taken back off the bill too, or
    // the invoice stays reduced by a credit that no longer exists.
    if (was.data.invoice_id) {
      const inv = await supabase.from('invoices')
        .select('invoice_id, credit_amount')
        .eq('invoice_id', was.data.invoice_id).eq('store_id', store_id).maybeSingle();
      if (inv.data) {
        await supabase.from('invoices').update({
          credit_amount: Math.max(0, money(inv.data.credit_amount) - money(was.data.amount)),
          updated_at: new Date().toISOString(),
        }).eq('invoice_id', was.data.invoice_id).eq('store_id', store_id);
      }
    }

    const gone = await supabase.from('vendor_credits')
      .update({ status: 'void', updated_at: new Date().toISOString() })
      .eq('credit_id', body.credit_id).eq('store_id', store_id);
    if (gone.error) return json(500, { error: gone.error.message });
    return json(200, { ok: true, says: 'Credit taken off.' });
  }

  // ---- writing one down ------------------------------------------------
  const amount = money(body.amount);
  if (!(amount > 0)) return json(400, { error: 'How much is the credit?' });

  const vendor_id = body.vendor_id || null;
  if (!vendor_id) return json(400, { error: 'Which vendor owes it?' });

  const reason = REASONS[body.reason] ? body.reason : 'other';
  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(body.credit_date || ''))
    ? body.credit_date : pacificToday();
  if (when > pacificToday()) return json(400, { error: 'That date has not happened yet.' });

  const vendor = await supabase.from('vendors').select('vendor_id, name')
    .eq('vendor_id', vendor_id).eq('store_id', store_id).maybeSingle();
  if (vendor.error) return json(500, { error: vendor.error.message });
  if (!vendor.data) return json(400, { error: 'That is not one of your vendors.' });

  // ---- against a particular bill ---------------------------------------
  let invoice = null;
  if (body.invoice_id) {
    const got = await supabase.from('invoices')
      .select('invoice_id, invoice_number, vendor_id, total_amount, amount_paid, credit_amount, balance_due, status')
      .eq('invoice_id', body.invoice_id).eq('store_id', store_id).maybeSingle();
    if (got.error) return json(500, { error: got.error.message });
    if (!got.data) return json(404, { error: 'No such bill.' });
    invoice = got.data;

    if (invoice.vendor_id !== vendor_id) {
      return json(400, {
        error: 'That bill belongs to a different vendor. A credit has to sit '
          + 'against the vendor who owes it, or it comes off the wrong check.',
      });
    }
    if (OPEN.indexOf(invoice.status) === -1) {
      return json(409, {
        error: 'That bill is ' + invoice.status + ', so there is nothing left to '
          + 'reduce. Record this as a credit on account instead and it will come '
          + 'off the next check.',
      });
    }

    const already = money(invoice.credit_amount);
    const owed = money(invoice.balance_due);
    if (amount > owed) {
      return json(409, {
        error: 'That credit is larger than the ' + dollars(owed) + ' still owed on '
          + 'the bill. Credit ' + dollars(owed) + ' against it and put the rest on '
          + 'account, or the bill would go into negative.',
        owed: owed,
      });
    }

    if (!(await creditsCount())) {
      return json(503, {
        error: 'Credits cannot be taken off a bill on this database yet — the '
          + 'change that makes what you owe count them has not been applied. '
          + 'Recording it would reduce nothing and you would short-pay against '
          + 'a figure that had not moved.',
      });
    }

    const up = await supabase.from('invoices').update({
      credit_amount: money(already + amount),
      updated_at: new Date().toISOString(),
    }).eq('invoice_id', invoice.invoice_id).eq('store_id', store_id);
    if (up.error) return json(500, { error: up.error.message });
  }

  const put = await supabase.from('vendor_credits').insert({
    store_id: store_id,
    vendor_id: vendor_id,
    credit_date: when,
    amount: amount,
    reason: reason,
    invoice_id: invoice ? invoice.invoice_id : null,
    // A credit against a bill has already done its work the moment the
    // bill shrinks; one on account is still waiting for a check.
    status: invoice ? 'applied' : 'open',
    applied_at: invoice ? new Date().toISOString() : null,
    note: String(body.note || '').trim() || null,
  }).select('credit_id').single();
  if (put.error) return json(500, { error: put.error.message });

  return json(200, {
    ok: true,
    credit_id: put.data.credit_id,
    says: invoice
      ? dollars(amount) + ' credited against invoice '
        + (invoice.invoice_number || 'that bill') + '. You now owe '
        + dollars(money(invoice.balance_due) - amount) + ' on it.'
      : dollars(amount) + ' credit recorded against ' + vendor.data.name
        + '. It will come off the next check you write them.',
  });
});

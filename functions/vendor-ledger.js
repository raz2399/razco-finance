// Netlify Function: vendor-ledger
// One vendor, every line, in order, with a running balance.
//
//   GET ?store_id=store1&q=salt            -> vendors matching, with balances
//   GET ?store_id=store1&vendor_id=<uuid>  -> that vendor's whole ledger
//
// Options on the ledger:
//   from, to       business dates, inclusive
//   sort           date | number | amount | type | entered
//   dir            asc | desc
//   include        open | all     (default all)
//
// What this is for: QuickBooks shows a vendor as a total, and a total
// cannot be argued with. Raz needs the lines -- this invoice, that check,
// on this date, for this amount -- because that is what a vendor's
// statement is compared against when they phone up saying he owes them
// money he thinks he has paid.
//
// A running balance is only meaningful in date order, so it is worked out
// in date order first and the rows are sorted afterwards, whatever sort was
// asked for. Sorting by amount and then adding up the column underneath
// would produce a balance that means nothing.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, storeFor, safely } = require('./lib/guard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const METHOD_LABEL = {
  cod: 'COD', cod_draft: 'COD draft', auto_debit: 'Auto-draft',
  charge_account: 'Charge', check: 'Check', unknown: null,
};

exports.handler = safely('vendor-ledger', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const store_id = storeFor(auth.user, q.store_id);
  if (!store_id) return json(403, { error: 'Not your store.' });

  try {
    // ---------------- finding a vendor ----------------
    if (!q.vendor_id) {
      const needle = String(q.q || '').trim().toLowerCase();

      const [vendRes, aliasRes, invRes] = await Promise.all([
        supabase.from('vendors')
          .select('vendor_id, name, payment_type, terms_code, active')
          .eq('store_id', store_id),
        supabase.from('vendor_aliases').select('vendor_id, alias_text'),
        supabase.from('invoices')
          .select('vendor_id, balance_due, status, due_date')
          .eq('store_id', store_id),
      ]);

      const aliases = {};
      (aliasRes.data || []).forEach((a) => {
        (aliases[a.vendor_id] = aliases[a.vendor_id] || []).push(a.alias_text);
      });

      // What is still owed, per vendor.
      const owed = {};
      const openCount = {};
      const nextDue = {};
      (invRes.data || []).forEach((i) => {
        if (['paid', 'void'].indexOf(i.status) > -1) return;
        // Nothing left on it is nothing owed, whatever the status says. The
        // status and the balance can disagree -- a bill marked already paid
        // keeps whatever status it had -- and the balance is the truth.
        if (money(i.balance_due) <= 0) return;
        owed[i.vendor_id] = money((owed[i.vendor_id] || 0) + money(i.balance_due));
        openCount[i.vendor_id] = (openCount[i.vendor_id] || 0) + 1;
        if (i.due_date && (!nextDue[i.vendor_id] || i.due_date < nextDue[i.vendor_id])) {
          nextDue[i.vendor_id] = i.due_date;
        }
      });

      const matches = (v) => {
        if (!needle) return true;
        if (String(v.name || '').toLowerCase().indexOf(needle) > -1) return true;
        return (aliases[v.vendor_id] || [])
          .some((a) => String(a).toLowerCase().indexOf(needle) > -1);
      };

      const vendors = (vendRes.data || []).filter(matches).map((v) => ({
        vendor_id: v.vendor_id,
        name: v.name,
        aliases: aliases[v.vendor_id] || [],
        pay_method: v.payment_type === 'unknown' ? null : v.payment_type,
        method_label: METHOD_LABEL[v.payment_type] || null,
        terms: v.terms_code || '',
        active: v.active !== false,
        owed: owed[v.vendor_id] || 0,
        open_count: openCount[v.vendor_id] || 0,
        next_due: nextDue[v.vendor_id] || null,
      }));

      // Owed first, then alphabetical: the ones with money against them are
      // the ones being looked for.
      vendors.sort((a, b) => {
        if ((b.owed !== 0) !== (a.owed !== 0)) return (b.owed !== 0) ? 1 : -1;
        if (b.owed !== a.owed) return b.owed - a.owed;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });

      return json(200, {
        store_id,
        query: q.q || '',
        count: vendors.length,
        total_owed: money(vendors.reduce((s, v) => s + v.owed, 0)),
        vendors: vendors.slice(0, 60),
        truncated: vendors.length > 60,
      });
    }

    // ---------------- one vendor's ledger ----------------
    const vendor_id = q.vendor_id;

    const [vRes, invRes, payRes, allocRes] = await Promise.all([
      supabase.from('vendors')
        .select('vendor_id, name, payment_type, terms_code, terms_days, account_number, contact_phone')
        .eq('vendor_id', vendor_id).eq('store_id', store_id).maybeSingle(),
      supabase.from('invoices')
        .select('invoice_id, invoice_number, invoice_date, received_date, due_date, total_amount, amount_paid, balance_due, status, payment_type, notes, created_at')
        .eq('store_id', store_id).eq('vendor_id', vendor_id),
      supabase.from('payments')
        .select('payment_id, method, payment_date, amount, check_number, memo, status, cleared_date, created_at')
        .eq('store_id', store_id).eq('vendor_id', vendor_id),
      supabase.from('payment_allocations').select('payment_id, invoice_id, amount'),
    ]);

    if (!vRes.data) return json(404, { error: 'No such vendor.' });
    const vendor = vRes.data;

    const settles = {};
    (allocRes.data || []).forEach((a) => {
      (settles[a.payment_id] = settles[a.payment_id] || []).push(a.invoice_id);
    });

    // How much of each invoice a payment recorded HERE accounts for.
    //
    // This matters because amount_paid on an invoice can move without any
    // payment row behind it: a bill settled before this system existed, or
    // one he marks as already paid. Left out of the sum, such an invoice
    // reads as owed in full for ever, however many times it is marked paid.
    const allocatedTo = {};
    (allocRes.data || []).forEach((a) => {
      allocatedTo[a.invoice_id] = money((allocatedTo[a.invoice_id] || 0) + money(a.amount));
    });

    const entries = [];

    (invRes.data || []).forEach((i) => {
      // A voided invoice stays visible -- he needs to see that it was
      // entered and killed, or he enters it again -- but it moves no money.
      // Left counting, a mistake he already corrected would go on being
      // owed, which is how a ledger ends up disagreeing with the vendor.
      const dead = i.status === 'void';
      entries.push({
        kind: 'invoice',
        id: i.invoice_id,
        voided: dead,
        // The day the goods arrived is the day it counts against him, and
        // that is what a vendor's statement is dated by.
        date: i.invoice_date || i.received_date,
        number: i.invoice_number || null,
        label: i.invoice_number === 'QB-OPEN'
          ? 'Opening balance from QuickBooks'
          : ('Invoice ' + (i.invoice_number || '(no number)')),
        charge: dead ? 0 : money(i.total_amount),
        paid: 0,
        // Money against this invoice that no payment here accounts for:
        // settled before this system, or marked already paid. It comes off
        // the balance at the invoice's own line, because that is when it
        // stopped being owed -- there is no payment line to take it off at.
        paid_outside: dead ? 0 : Math.max(0,
          money(money(i.amount_paid) - (allocatedTo[i.invoice_id] || 0))),
        // What it was for, kept for the screen even when it counts nothing.
        face_amount: money(i.total_amount),
        balance_due: dead ? 0 : money(i.balance_due),
        status: i.status,
        due_date: i.due_date,
        method: i.payment_type,
        method_label: METHOD_LABEL[i.payment_type] || null,
        opening: i.invoice_number === 'QB-OPEN',
        note: i.notes || null,
        entered_at: i.created_at,
      });
    });

    (payRes.data || []).forEach((p) => {
      const against = settles[p.payment_id] || [];
      // A voided or stopped check never left the building. Same reasoning
      // as a voided invoice: it shows, it counts nothing.
      const dead = p.status === 'void' || p.status === 'stopped';
      entries.push({
        kind: 'payment',
        id: p.payment_id,
        voided: dead,
        date: p.payment_date,
        number: p.check_number ? String(p.check_number) : null,
        label: (p.method === 'check' ? 'Check #' + (p.check_number || '?')
               : p.method === 'auto_debit' ? 'Bank draft'
               : p.method === 'cod_draft' ? 'COD draft'
               : 'Payment') + (p.memo ? ' — ' + p.memo : ''),
        charge: 0,
        paid: dead ? 0 : money(p.amount),
        paid_outside: 0,
        face_amount: money(p.amount),
        status: p.status,
        cleared_date: p.cleared_date || null,
        // A check written but not yet cashed is money promised, not money
        // gone. The ledger says which.
        settled: p.status === 'cleared',
        against_invoices: against.length,
        standalone: against.length === 0,
        entered_at: p.created_at,
      });
    });

    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : null;

    // Running balance in date order, always, before any sorting. The
    // balance after a line only means anything if the lines before it are
    // the ones that actually came before it.
    entries.sort((a, b) => {
      if (a.date !== b.date) return (a.date || '') < (b.date || '') ? -1 : 1;
      // Same day: the invoice lands before the payment that settles it.
      if (a.kind !== b.kind) return a.kind === 'invoice' ? -1 : 1;
      return String(a.entered_at || '') < String(b.entered_at || '') ? -1 : 1;
    });

    let running = 0;
    entries.forEach((e) => {
      running = money(running + e.charge - e.paid - e.paid_outside);
      e.balance_after = running;
    });

    let shown = entries;
    if (from) shown = shown.filter((e) => (e.date || '') >= from);
    if (to) shown = shown.filter((e) => (e.date || '') <= to);
    if (q.include === 'open') {
      shown = shown.filter((e) => e.kind === 'invoice' && e.balance_due > 0);
    }

    const sort = ['date', 'number', 'amount', 'type', 'entered'].indexOf(q.sort) > -1
      ? q.sort : 'date';
    const dir = q.dir === 'asc' ? 1 : -1;

    const key = {
      date: (e) => e.date || '',
      // Invoice numbers are text and sort as text, except where they are
      // plainly numbers, in which case 9 belongs before 10.
      number: (e) => {
        const n = e.number || '';
        return /^\d+$/.test(n) ? String(n).padStart(12, '0') : n.toLowerCase();
      },
      amount: (e) => (e.charge || e.paid),
      type: (e) => e.kind,
      entered: (e) => String(e.entered_at || ''),
    }[sort];

    shown = shown.slice().sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka === kb) return (a.date || '') < (b.date || '') ? -dir : dir;
      return ka < kb ? -dir : dir;
    });

    const open = entries.filter((e) => e.kind === 'invoice' && e.balance_due > 0);
    const uncashed = entries.filter((e) =>
      e.kind === 'payment' && !e.settled && !e.voided);
    const voided = entries.filter((e) => e.voided);

    return json(200, {
      store_id,
      vendor: {
        vendor_id: vendor.vendor_id,
        name: vendor.name,
        pay_method: vendor.payment_type === 'unknown' ? null : vendor.payment_type,
        method_label: METHOD_LABEL[vendor.payment_type] || null,
        terms: vendor.terms_code || '',
        terms_days: vendor.terms_days,
        account_number: vendor.account_number || null,
        phone: vendor.contact_phone || null,
      },
      totals: {
        charged: money(entries.reduce((s, e) => s + e.charge, 0)),
        paid: money(entries.reduce((s, e) => s + e.paid, 0)),
        // Settled with no payment recorded here -- paid before this system,
        // or marked already paid. Shown on its own line because it is not
        // money this system ever saw move, and adding it to "paid" would
        // claim a payment it cannot show him.
        paid_outside: money(entries.reduce((s, e) => s + e.paid_outside, 0)),
        // What he owes right now: the balance after the last line in date
        // order, which is why the running balance is computed before any
        // sorting is applied.
        owed: running,
        voided_lines: voided.length,
        open_invoices: open.length,
        open_total: money(open.reduce((s, e) => s + e.balance_due, 0)),
        checks_not_cashed: uncashed.length,
        checks_not_cashed_total: money(uncashed.reduce((s, e) => s + e.paid, 0)),
        // Shown separately so a figure carried over from QuickBooks is
        // never mistaken for a bill somebody has actually seen.
        from_quickbooks: money(entries.filter((e) => e.opening)
          .reduce((s, e) => s + e.balance_due, 0)),
      },
      sort: sort,
      dir: dir === 1 ? 'asc' : 'desc',
      from: from, to: to,
      count: shown.length,
      entries: shown,
    });
  } catch (err) {
    return json(500, { error: err.message, where: 'vendor-ledger' });
  }
});

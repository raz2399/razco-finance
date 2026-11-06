// The statement, marked.
//
// Reconciling a paper statement means running a highlighter down it: the
// marked lines are the ones you have dealt with, and what is left is the
// work. Until now Razi-Nova had no such page at all -- the bank feed went
// in, settlement ran, and there was nowhere to look at the result as a
// statement.
//
// The states themselves live in lib/mark.js so they can be tested
// without touching his books. This file fetches, and does the one press.
//
// ---------------------------------------------------------------------
// One press
//
// The page's job is that the work on it can be finished without picking
// through it line by line. `apply_all` does two things in order:
//
//   1. settlement -- everything the bank proves already happened
//   2. the namings nobody has to think about -- a cleared check whose
//      amount is exactly one open invoice
//
// Anything less than certain is left on the page for him. The system
// never guesses which vendor got the money.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { plan, apply } = require('./lib/settlerun');
const { spread, statusAfter } = require('./lib/settle');
const { readRow, tally, money, OPEN } = require('./lib/mark');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const dollars = (n) => '$' + money(n).toFixed(2)
  .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

async function readAll(table, columns, shape) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await shape(supabase.from(table).select(columns)).range(from, from + 999);
    if (res.error) throw new Error(table + ': ' + res.error.message);
    const got = res.data || [];
    out.push.apply(out, got);
    if (got.length < 1000) return out;
  }
}

async function gather(store_id, sinceDate) {
  const [rows, payments, invoices, vendors] = await Promise.all([
    readAll('bank_transactions',
      'bank_txn_id, posted_date, description, amount, check_number, is_pending',
      (q) => q.eq('store_id', store_id).gte('posted_date', sinceDate)
        .order('posted_date', { ascending: false })),
    readAll('payments',
      'payment_id, bank_txn_id, vendor_id, amount, check_number, settles_ap',
      (q) => q.eq('store_id', store_id)),
    readAll('invoices',
      'invoice_id, vendor_id, invoice_number, invoice_date, due_date, total_amount, amount_paid, balance_due, status',
      (q) => q.eq('store_id', store_id).in('status', OPEN)),
    readAll('vendors', 'vendor_id, name', (q) => q.eq('store_id', store_id)),
  ]);

  const vName = {};
  vendors.forEach((v) => { vName[v.vendor_id] = v.name; });

  const byTxn = {};
  payments.forEach((p) => { if (p.bank_txn_id) byTxn[p.bank_txn_id] = p; });

  return {
    rows: rows,
    invoices: invoices,
    vName: vName,
    marked: rows.map((t) => readRow(t, byTxn[t.bank_txn_id] || null, vName, invoices)),
  };
}

exports.handler = safely('statement', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  const days = Math.min(Math.max(Number(body.days || q.days) || 21, 1), 180);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // ---- one press -------------------------------------------------------
  if (event.httpMethod === 'POST' && body.action === 'apply_all') {
    const did = { settled: 0, named: 0, invoices: 0, money_named: 0, problems: [] };

    const planned = await plan(supabase, store_id);
    if (planned.ok) {
      const done = await apply(supabase, store_id, planned);
      did.settled = done.wrote.payments + done.wrote.costs;
      did.invoices += done.wrote.invoices;
      did.problems = (done.problems || []).slice();
    } else if (planned.error) {
      did.problems.push(planned.error);
    }

    // Read the statement back AFTER settling, so a check settlement has
    // just recorded gets its chance at a name in the same press.
    const ctx = await gather(store_id, since);
    const sure = ctx.marked.filter((r) => r.suggest && !r.pending);

    // Invoices are claimed as we go: two checks for the same figure must
    // not both settle the one bill.
    const taken = {};
    for (let i = 0; i < sure.length; i++) {
      const s = sure[i].suggest;
      if (taken[s.invoice_id]) continue;
      taken[s.invoice_id] = true;

      const inv = ctx.invoices.filter((x) => x.invoice_id === s.invoice_id)[0];
      if (!inv || money(inv.balance_due) <= 0) continue;

      const parts = spread(Math.abs(sure[i].amount), [inv]).parts;
      if (!parts.length) continue;

      const up = await supabase.from('payments')
        .update({ vendor_id: s.vendor_id, updated_at: new Date().toISOString() })
        .eq('payment_id', s.payment_id).eq('store_id', store_id);
      if (up.error) { did.problems.push(up.error.message); continue; }

      const al = await supabase.from('payment_allocations').insert({
        payment_id: s.payment_id,
        invoice_id: inv.invoice_id,
        amount: parts[0].amount,
        created_from_bank: true,
      });
      if (al.error) { did.problems.push(al.error.message); continue; }

      await supabase.from('invoices').update({
        amount_paid: parts[0].paid_after,
        status: statusAfter(inv.total_amount, parts[0].paid_after),
        updated_at: new Date().toISOString(),
      }).eq('invoice_id', inv.invoice_id).eq('store_id', store_id);

      did.named += 1;
      did.invoices += 1;
      did.money_named = money(did.money_named + parts[0].amount);
    }

    const bits = [];
    if (did.settled) {
      bits.push(did.settled + ' line' + (did.settled === 1 ? '' : 's')
        + ' read off the bank');
    }
    if (did.named) {
      bits.push(did.named + ' check' + (did.named === 1 ? '' : 's')
        + ' matched to a bill by the amount, ' + dollars(did.money_named)
        + ' off what you owe');
    }

    return json(200, {
      ok: true,
      did: did,
      says: bits.length
        ? bits.join('. ') + '.'
        : 'Nothing left to do -- everything the bank knows is on the books.',
    });
  }

  // ---- the statement ---------------------------------------------------
  const ctx = await gather(store_id, since);
  const counts = tally(ctx.marked);

  return json(200, {
    ok: true,
    since: since,
    days: days,
    count: ctx.marked.length,
    counts: counts,
    rows: ctx.marked,
    says: counts.can_name
      ? counts.can_name + ' of these match an open bill by the amount alone.'
      : counts.needs
        ? counts.needs + ' line' + (counts.needs === 1 ? '' : 's')
          + ' still want something from you.'
        : 'Everything that cleared is accounted for.',
  });
});

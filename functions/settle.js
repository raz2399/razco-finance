// Netlify Function: settle
//
//   GET  ?store_id=store1              -> what settling would do, changing nothing
//   POST { store_id, action:"run" }    -> do it
//   POST { store_id, action:"undo" }   -> take all of it back
//
// The GET is the honest default. Nothing about money should happen
// because a page was loaded.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { plan, apply, undo } = require('./lib/settlerun');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const dollars = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100)
  .toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// What the plan amounts to, in words, so the screen does not have to
// work it out and two screens cannot word it differently.
function inWords(p) {
  if (!p.ok) return p.why;
  const t = p.totals;
  if (!t.payments_to_create && !t.checks_confirmed && !t.costs_to_record) {
    return 'The books already agree with the bank. Nothing to settle.';
  }
  const bits = [];
  if (t.payments_to_create) {
    bits.push(t.payments_to_create + ' payment' + (t.payments_to_create === 1 ? '' : 's')
      + ' the bank knows about and the books do not, worth '
      + dollars(t.money_to_record));
  }
  if (t.checks_confirmed) {
    bits.push(t.checks_confirmed + ' check' + (t.checks_confirmed === 1 ? '' : 's')
      + ' you logged, now confirmed as cleared');
  }
  if (t.costs_to_record) {
    bits.push(t.costs_to_record + ' cost' + (t.costs_to_record === 1 ? '' : 's')
      + ' worth ' + dollars(t.money_in_costs) + ' that were reaching no figure at all '
      + '— payroll, the tax drafts, the card purchases');
  }
  if (t.settled_by_learning) {
    bits.push(t.settled_by_learning + ' more settled once it worked out how the bank '
      + 'spells those vendors');
  }
  if (t.need_naming) {
    bits.push(t.need_naming + ' line' + (t.need_naming === 1 ? '' : 's')
      + ' it will not guess at — name those below');
  }
  if (t.money_onto_invoices) {
    bits.push(dollars(t.money_onto_invoices) + ' coming off what you owe across '
      + t.invoices_to_touch + ' invoice' + (t.invoices_to_touch === 1 ? '' : 's'));
  }
  if (t.credit_left_over) {
    bits.push(dollars(t.credit_left_over) + ' left as credit on account, because there '
      + 'was no open invoice to put it against');
  }
  if (t.disagreements) {
    bits.push(t.disagreements + ' check' + (t.disagreements === 1 ? '' : 's')
      + ' that cleared for a different amount than you wrote — these need your eyes '
      + 'and nothing was changed on them');
  }
  return bits.join('. ') + '.';
}

exports.handler = safely('settle', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  // ---- whose was this? ------------------------------------------------
  //
  // A bank line says a check cleared. It does not say who it was to, and
  // seven of his say nothing a computer can use. The honest thing is to
  // ask once rather than guess -- a guess here puts one vendor's money
  // against another vendor's bills, and nobody finds out until a
  // statement arrives months later.
  //
  // This is still less work than QuickBooks, where all seven would be
  // typed from nothing. Here the date, the number and the amount are
  // already right and he picks a name.
  //
  // Checks written through Print checks never land in this queue: the
  // vendor is known before the check leaves the printer. The queue is
  // the backlog, not the future.
  if (event.httpMethod === 'POST' && body.action === 'attribute') {
    const paymentId = body.payment_id;
    const vendorId = body.vendor_id;
    if (!paymentId || !vendorId) return json(400, { error: 'Which payment, and which vendor?' });

    const pay = await supabase.from('payments')
      .select('payment_id, amount, vendor_id, check_number, payment_date')
      .eq('payment_id', paymentId).eq('store_id', store_id).maybeSingle();
    if (pay.error || !pay.data) return json(404, { error: 'That payment is not on file.' });
    if (pay.data.vendor_id) {
      return json(409, { error: 'That payment already belongs to a vendor.' });
    }

    const open = await supabase.from('invoices')
      .select('invoice_id, invoice_date, total_amount, amount_paid, balance_due')
      .eq('store_id', store_id).eq('vendor_id', vendorId)
      .in('status', ['approved', 'scheduled', 'partially_paid']);
    if (open.error) return json(500, { error: open.error.message });

    const { spread, statusAfter } = require('./lib/settle');
    const s = spread(pay.data.amount, open.data || []);

    await supabase.from('payments').update({
      vendor_id: vendorId, updated_at: new Date().toISOString(),
    }).eq('payment_id', paymentId).eq('store_id', store_id);

    let landed = 0;
    for (let i = 0; i < s.parts.length; i++) {
      const part = s.parts[i];
      const al = await supabase.from('payment_allocations').insert({
        payment_id: paymentId, invoice_id: part.invoice_id,
        amount: part.amount, created_from_bank: true,
      });
      if (al.error) continue;
      const inv = (open.data || []).filter((x) => x.invoice_id === part.invoice_id)[0];
      await supabase.from('invoices').update({
        amount_paid: part.paid_after,
        status: statusAfter(inv.total_amount, part.paid_after),
        updated_at: new Date().toISOString(),
      }).eq('invoice_id', part.invoice_id).eq('store_id', store_id);
      landed += part.amount;
    }

    return json(200, {
      ok: true,
      invoices_settled: s.parts.length,
      money_applied: Math.round(landed * 100) / 100,
      credit_left: s.left_over,
      says: s.parts.length
        ? dollars(landed) + ' came off ' + s.parts.length + ' invoice'
          + (s.parts.length === 1 ? '' : 's')
          + (s.left_over ? ', and ' + dollars(s.left_over) + ' is sitting as credit.' : '.')
        : 'That vendor has nothing open, so the whole '
          + dollars(pay.data.amount) + ' is credit on their account.',
    });
  }

  if (event.httpMethod === 'POST' && body.action === 'undo') {
    const back = await undo(supabase, store_id);
    return json(200, {
      ok: true,
      undone: back,
      says: 'Took back ' + back.payments + ' payment' + (back.payments === 1 ? '' : 's')
        + ' the system had read from the bank. Anything you typed yourself was left alone.',
    });
  }

  // Payments on the books that nobody can tell the owner of. Money that
  // certainly left, sitting against no vendor and therefore coming off
  // nothing he owes.
  if (event.httpMethod === 'GET' && q.unattributed) {
    const rows = await supabase.from('payments')
      .select('payment_id, amount, payment_date, check_number, method, memo')
      .eq('store_id', store_id).is('vendor_id', null)
      .neq('status', 'void')
      .order('payment_date', { ascending: false }).limit(200);
    if (rows.error) return json(500, { error: rows.error.message });
    const list = rows.data || [];
    const total = list.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return json(200, {
      ok: true,
      count: list.length,
      total: Math.round(total * 100) / 100,
      payments: list,
      says: list.length
        ? list.length + ' payment' + (list.length === 1 ? '' : 's') + ' worth '
          + dollars(total) + ' left the bank with no vendor against them, so '
          + 'they are coming off nothing you owe. Name each one once.'
        : 'Every payment on the books belongs to a vendor.',
    });
  }

  const planned = await plan(supabase, store_id);
  if (!planned.ok) return json(409, { error: planned.why, cutover: planned.cutover });

  if (event.httpMethod !== 'POST' || body.action !== 'run') {
    // Looking, not touching.
    return json(200, {
      ok: true,
      dry_run: true,
      cutover: planned.cutover,
      totals: planned.totals,
      says: inWords(planned),
      // Capped: this is a summary for a screen, not an export.
      would_create: planned.created.slice(0, 50),
      would_confirm: planned.linked.slice(0, 50),
      would_cost: planned.costs.slice(0, 80),
      to_ask: planned.to_ask.slice(0, 50),
      aliases_to_learn: planned.learn.slice(0, 50),
      disagreements: planned.disagreements,
      left_alone: planned.skipped.slice(0, 50),
    });
  }

  const done = await apply(supabase, store_id, planned);
  return json(200, {
    ok: true,
    cutover: planned.cutover,
    wrote: done.wrote,
    problems: done.problems,
    totals: planned.totals,
    disagreements: planned.disagreements,
    says: inWords(planned)
      + (done.problems.length ? ' ' + done.problems.length + ' line(s) had a problem and were left.' : ''),
  });
});

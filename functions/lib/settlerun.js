// Doing it: turning bank lines into payments and settling invoices.
//
// The thinking is in settle.js. This is the part that writes, and it is
// deliberately boring: read everything first, decide everything second,
// write third. Deciding while writing is how a half-finished pass leaves
// books that disagree with themselves.
//
// Every write is marked as the system's own, so the whole thing can be
// undone later without touching a row he typed.

const {
  money, readLine, spread, statusAfter,
} = require('./settle');

const BUSINESS_TZ = 'America/Los_Angeles';
const pacificToday = () => new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });

// Statuses that mean an invoice is still waiting for money.
const OPEN = ['approved', 'scheduled', 'partially_paid'];

// Statuses that mean a payment is real. A voided or stopped one is not
// money that left.
const DEAD_PAYMENT = { void: 1, stopped: 1 };

async function readAll(supabase, table, columns, shape) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const res = await shape(supabase.from(table).select(columns))
      .range(from, from + size - 1);
    if (res.error) throw new Error(table + ': ' + res.error.message);
    const got = res.data || [];
    out.push.apply(out, got);
    if (got.length < size) return out;
  }
}

/**
 * Work out what SHOULD happen, touching nothing.
 *
 * Returned whole so the caller can show it to him before any of it is
 * written -- which is what "dry_run" is for, and what the Reconcile
 * screen shows before he presses anything.
 */
async function plan(supabase, store_id, opts) {
  const options = opts || {};

  const settings = await supabase.from('store_settings')
    .select('cutover_date, autosettle').eq('store_id', store_id).maybeSingle();
  if (settings.error) throw new Error('settings: ' + settings.error.message);

  // No cutover date, no settlement. Guessing one would be guessing which
  // half of his history is already inside the opening balances.
  const cutover = (settings.data && settings.data.cutover_date) || null;
  if (!cutover) {
    return {
      ok: false,
      why: 'No cutover date is set for this store, so there is no way to tell '
         + 'which bank lines are already inside the opening balances. '
         + 'Nothing was changed.',
      cutover: null,
      created: [], linked: [], allocated: [], skipped: [], disagreements: [],
    };
  }

  const [txns, payments, invoices, vendors] = await Promise.all([
    readAll(supabase, 'bank_transactions',
      'bank_txn_id, posted_date, description, amount, check_number, is_pending, vendor_id',
      (q) => q.eq('store_id', store_id).gte('posted_date', cutover)
        .order('posted_date', { ascending: true })),
    readAll(supabase, 'payments',
      'payment_id, vendor_id, amount, payment_date, check_number, status, method, bank_txn_id, created_from_bank',
      (q) => q.eq('store_id', store_id)),
    readAll(supabase, 'invoices',
      'invoice_id, vendor_id, invoice_number, invoice_date, total_amount, amount_paid, balance_due, status',
      (q) => q.eq('store_id', store_id).in('status', OPEN)),
    readAll(supabase, 'vendors', 'vendor_id, name', (q) => q.eq('store_id', store_id)),
  ]);

  // Bank lines already answered for. Never twice.
  const spokenFor = {};
  payments.forEach((p) => { if (p.bank_txn_id) spokenFor[p.bank_txn_id] = p; });

  // Checks already in the books, by number.
  const byCheck = {};
  payments.forEach((p) => {
    if (p.check_number != null && !DEAD_PAYMENT[p.status]) {
      byCheck[String(p.check_number)] = p;
    }
  });

  // Open invoices per vendor. Balances are tracked as the plan is built,
  // so two checks to one vendor in the same pass do not both claim the
  // same invoice.
  const openFor = {};
  invoices.forEach((inv) => {
    if (!inv.vendor_id) return;
    if (!openFor[inv.vendor_id]) openFor[inv.vendor_id] = [];
    openFor[inv.vendor_id].push({
      invoice_id: inv.invoice_id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      total_amount: money(inv.total_amount),
      amount_paid: money(inv.amount_paid),
      balance_due: money(inv.balance_due),
      status: inv.status,
    });
  });

  const created = [];
  const linked = [];
  const allocated = [];
  const skipped = [];
  const disagreements = [];

  for (let i = 0; i < txns.length; i++) {
    const t = txns[i];

    if (spokenFor[t.bank_txn_id]) {
      skipped.push({ bank_txn_id: t.bank_txn_id, why: 'already accounted for' });
      continue;
    }

    const read = readLine(t, vendors);
    if (read.kind === 'skip') {
      skipped.push({
        bank_txn_id: t.bank_txn_id, date: t.posted_date,
        description: t.description, amount: money(t.amount), why: read.why,
      });
      continue;
    }

    let vendorId = null;
    let payment = null;

    if (read.kind === 'check') {
      const mine = byCheck[String(read.check_number)];
      if (mine) {
        // He wrote this one down. The bank is confirming it, not
        // replacing it.
        if (money(mine.amount) !== read.amount) {
          // Not smoothed over. A check that cleared for a different
          // figure than it was written for is either a mistake or
          // somebody altering a check, and both need his eyes.
          disagreements.push({
            check_number: read.check_number,
            written_for: money(mine.amount),
            cleared_for: read.amount,
            bank_txn_id: t.bank_txn_id,
            payment_id: mine.payment_id,
            posted_date: t.posted_date,
          });
          continue;
        }
        linked.push({
          payment_id: mine.payment_id,
          bank_txn_id: t.bank_txn_id,
          check_number: read.check_number,
          cleared_date: t.posted_date,
          amount: read.amount,
        });
        // A payment he typed may already be allocated. Leave its money
        // alone; only mark it cleared.
        spokenFor[t.bank_txn_id] = mine;
        continue;
      }

      // A check the books have never heard of. The bank saw it clear, so
      // it happened. Whose it was may be unknown, and that is allowed:
      // unattributed money that left is still money that left.
      vendorId = t.vendor_id || null;
      payment = {
        bank_txn_id: t.bank_txn_id,
        method: 'check',
        check_number: read.check_number,
        amount: read.amount,
        payment_date: t.posted_date,
        vendor_id: vendorId,
        memo: 'Check ' + read.check_number + ' — read from the bank',
      };
    } else {
      vendorId = read.vendor.vendor_id;
      payment = {
        bank_txn_id: t.bank_txn_id,
        // A vendor pulling their own money is a draft, not a check.
        method: 'auto_debit',
        check_number: null,
        amount: read.amount,
        payment_date: t.posted_date,
        vendor_id: vendorId,
        memo: read.vendor.name + ' — taken by the vendor, read from the bank',
      };
      payment.vendor_name = read.vendor.name;
    }

    // Where the money lands.
    let parts = [];
    let leftOver = payment.amount;
    if (vendorId && openFor[vendorId] && openFor[vendorId].length) {
      const s = spread(payment.amount, openFor[vendorId]);
      parts = s.parts;
      leftOver = s.left_over;
      // Keep the running balances honest within this pass.
      parts.forEach((part) => {
        const inv = openFor[vendorId].filter((x) => x.invoice_id === part.invoice_id)[0];
        if (!inv) return;
        inv.amount_paid = part.paid_after;
        inv.balance_due = money(inv.total_amount - part.paid_after);
        inv.status = statusAfter(inv.total_amount, part.paid_after);
      });
    }

    payment.allocations = parts;
    payment.left_over = leftOver;
    created.push(payment);
    if (parts.length) allocated.push({ bank_txn_id: t.bank_txn_id, parts: parts });
  }

  return {
    ok: true,
    cutover: cutover,
    autosettle: !!(settings.data && settings.data.autosettle),
    created: created,
    linked: linked,
    allocated: allocated,
    skipped: skipped,
    disagreements: disagreements,
    totals: {
      payments_to_create: created.length,
      money_to_record: money(created.reduce((s, p) => s + p.amount, 0)),
      invoices_to_touch: created.reduce((s, p) => s + p.allocations.length, 0),
      money_onto_invoices: money(created.reduce(
        (s, p) => s + p.allocations.reduce((t, a) => t + a.amount, 0), 0)),
      credit_left_over: money(created.reduce((s, p) => s + p.left_over, 0)),
      checks_confirmed: linked.length,
      lines_left_alone: skipped.length,
      disagreements: disagreements.length,
    },
  };
}

/**
 * Write the plan.
 *
 * A payment is written before its allocations, and the invoice is
 * updated last. If anything fails part way the pass stops and says where
 * -- and because every payment carries its bank line's id behind a
 * unique index, running it again picks up from where it stopped rather
 * than doing the first half twice.
 */
async function apply(supabase, store_id, planned) {
  const now = new Date().toISOString();
  const wrote = { payments: 0, allocations: 0, invoices: 0, cleared: 0 };
  const problems = [];

  const acct = await supabase.from('bank_accounts')
    .select('account_id').eq('store_id', store_id).limit(1).maybeSingle();
  const accountId = acct.data ? acct.data.account_id : null;

  // Checks he wrote down, now confirmed by the bank.
  for (let i = 0; i < planned.linked.length; i++) {
    const l = planned.linked[i];
    const upd = await supabase.from('payments').update({
      status: 'cleared',
      cleared_date: l.cleared_date,
      bank_txn_id: l.bank_txn_id,
      updated_at: now,
    }).eq('payment_id', l.payment_id).eq('store_id', store_id);
    if (upd.error) problems.push('check ' + l.check_number + ': ' + upd.error.message);
    else wrote.cleared += 1;
  }

  for (let i = 0; i < planned.created.length; i++) {
    const p = planned.created[i];

    const row = {
      store_id: store_id,
      account_id: accountId,
      method: p.method,
      payment_date: p.payment_date,
      amount: p.amount,
      vendor_id: p.vendor_id,
      check_number: p.check_number,
      memo: p.memo,
      // It cleared. That is what being on the statement means.
      status: 'cleared',
      cleared_date: p.payment_date,
      issued_at: new Date(p.payment_date + 'T12:00:00Z').toISOString(),
      bank_txn_id: p.bank_txn_id,
      created_from_bank: true,
      qb_synced: false,
    };

    const ins = await supabase.from('payments').insert(row)
      .select('payment_id').single();

    if (ins.error) {
      // The unique index doing its job: another pass already recorded
      // this line. Not an error, just nothing left to do.
      if (/duplicate key|unique/i.test(ins.error.message)) continue;
      problems.push('payment for ' + p.bank_txn_id + ': ' + ins.error.message);
      continue;
    }
    wrote.payments += 1;
    const paymentId = ins.data.payment_id;

    for (let j = 0; j < p.allocations.length; j++) {
      const a = p.allocations[j];
      const al = await supabase.from('payment_allocations').insert({
        payment_id: paymentId,
        invoice_id: a.invoice_id,
        amount: a.amount,
        created_from_bank: true,
      });
      if (al.error) { problems.push('allocation: ' + al.error.message); continue; }
      wrote.allocations += 1;

      // amount_paid is what the database derives balance_due from, so it
      // is the only figure sent. Sending balance_due as well would be
      // telling Postgres something it works out itself.
      const inv = await supabase.from('invoices')
        .select('total_amount, amount_paid')
        .eq('invoice_id', a.invoice_id).maybeSingle();
      if (inv.error || !inv.data) { problems.push('invoice read: ' + a.invoice_id); continue; }

      const paidAfter = money(money(inv.data.amount_paid) + a.amount);
      const upd = await supabase.from('invoices').update({
        amount_paid: paidAfter,
        status: statusAfter(inv.data.total_amount, paidAfter),
        updated_at: now,
      }).eq('invoice_id', a.invoice_id).eq('store_id', store_id);
      if (upd.error) problems.push('invoice ' + a.invoice_id + ': ' + upd.error.message);
      else wrote.invoices += 1;
    }
  }

  // The bank lines now have an answer.
  const answered = planned.created.map((p) => p.bank_txn_id)
    .concat(planned.linked.map((l) => l.bank_txn_id));
  for (let i = 0; i < answered.length; i += 100) {
    const batch = answered.slice(i, i + 100);
    if (!batch.length) continue;
    const upd = await supabase.from('bank_transactions').update({
      match_status: 'matched',
      matched_type: 'payment',
      matched_at: now,
      match_note: 'settled from the bank',
    }).in('bank_txn_id', batch).eq('store_id', store_id);
    if (upd.error) problems.push('marking bank lines: ' + upd.error.message);
  }

  return { wrote: wrote, problems: problems };
}

/**
 * Undo everything the system wrote, leaving every hand-typed row alone.
 *
 * This exists because a pass that cannot be undone is a pass nobody
 * should be willing to run on real books.
 */
async function undo(supabase, store_id) {
  const mine = await readAll(supabase, 'payments',
    'payment_id, bank_txn_id', (q) => q.eq('store_id', store_id).eq('created_from_bank', true));

  const undone = { payments: 0, invoices: 0 };
  for (let i = 0; i < mine.length; i++) {
    const p = mine[i];
    const allocs = await supabase.from('payment_allocations')
      .select('invoice_id, amount').eq('payment_id', p.payment_id);
    const rows = (allocs.data || []);

    for (let j = 0; j < rows.length; j++) {
      const inv = await supabase.from('invoices')
        .select('total_amount, amount_paid')
        .eq('invoice_id', rows[j].invoice_id).maybeSingle();
      if (!inv.data) continue;
      const back = money(money(inv.data.amount_paid) - money(rows[j].amount));
      await supabase.from('invoices').update({
        amount_paid: back < 0 ? 0 : back,
        status: statusAfter(inv.data.total_amount, back < 0 ? 0 : back),
      }).eq('invoice_id', rows[j].invoice_id).eq('store_id', store_id);
      undone.invoices += 1;
    }

    await supabase.from('payment_allocations').delete().eq('payment_id', p.payment_id);
    await supabase.from('payments').delete()
      .eq('payment_id', p.payment_id).eq('store_id', store_id)
      .eq('created_from_bank', true);
    undone.payments += 1;

    if (p.bank_txn_id) {
      await supabase.from('bank_transactions').update({
        match_status: 'unmatched', matched_type: null, matched_at: null, match_note: null,
      }).eq('bank_txn_id', p.bank_txn_id).eq('store_id', store_id);
    }
  }
  return undone;
}

module.exports = { plan, apply, undo, pacificToday, OPEN };

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
  money, spread, statusAfter,
} = require('./settle');
const { classifyLine, squash } = require('./classify');

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

  const [txns, payments, invoices, vendors, aliases, categories] = await Promise.all([
    readAll(supabase, 'bank_transactions',
      'bank_txn_id, posted_date, description, amount, check_number, is_pending, vendor_id, plaid_pending_id, plaid_transaction_id',
      (q) => q.eq('store_id', store_id).gte('posted_date', cutover)
        .order('posted_date', { ascending: true })),
    readAll(supabase, 'payments',
      'payment_id, vendor_id, amount, payment_date, check_number, status, method, bank_txn_id, created_from_bank, pending_plaid_id, settles_ap',
      (q) => q.eq('store_id', store_id)),
    readAll(supabase, 'invoices',
      'invoice_id, vendor_id, invoice_number, invoice_date, total_amount, amount_paid, balance_due, status',
      (q) => q.eq('store_id', store_id).in('status', OPEN)),
    readAll(supabase, 'vendors', 'vendor_id, name', (q) => q.eq('store_id', store_id)),
    readAll(supabase, 'vendor_aliases', 'vendor_id, alias_text, squashed',
      (q) => q.eq('store_id', store_id)),
    readAll(supabase, 'expense_categories', 'category_id, name', (q) => q.limit(500)),
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
  const costs = [];
  const skipped = [];
  const disagreements = [];
  const toAsk = [];
  const learn = [];

  // Categories by name, so a cost can be filed under something that
  // means a thing on the profit and loss.
  const catId = {};
  (categories || []).forEach((c) => { catId[String(c.name).toLowerCase()] = c.category_id; });

  // A payment already made against the PENDING version of a line. When
  // that line posts under a new id, the payment moves across rather than
  // a second one being created -- which is the one way this whole design
  // could quietly double his money.
  const byPending = {};
  payments.forEach((p) => {
    if (p.pending_plaid_id) byPending[p.pending_plaid_id] = p;
  });

  // Every open invoice, flat, for matching on amount alone.
  const allOpen = [];
  Object.keys(openFor).forEach((vid) => {
    openFor[vid].forEach((inv) => allOpen.push(Object.assign({ vendor_id: vid }, inv)));
  });

  const ctx = { vendors: vendors, aliases: aliases, openInvoices: allOpen };

  for (let i = 0; i < txns.length; i++) {
    const t = txns[i];

    if (spokenFor[t.bank_txn_id]) {
      skipped.push({ bank_txn_id: t.bank_txn_id, why: 'already accounted for' });
      continue;
    }

    // This posted line is the pending one we already paid. Carry the
    // payment over; do not make another.
    if (t.plaid_pending_id) {
      const already = byPending[t.plaid_pending_id];
      if (already) {
        linked.push({
          payment_id: already.payment_id,
          bank_txn_id: t.bank_txn_id,
          check_number: already.check_number,
          cleared_date: t.posted_date,
          amount: money(already.amount),
          // It was settled while pending and has now posted for real.
          // Carried across, not created again.
          was_pending: true,
          finalise: true,
        });
        spokenFor[t.bank_txn_id] = already;
        continue;
      }
    }

    const read = classifyLine(t, ctx);

    if (read.what === 'internal' || read.what === 'income') {
      skipped.push({
        bank_txn_id: t.bank_txn_id, date: t.posted_date,
        description: t.description, amount: money(t.amount),
        why: read.what === 'income' ? 'money came in' : 'moving his own money (' + read.code + ')',
      });
      continue;
    }

    // ---- a cost with no invoice behind it ----------------------------
    //
    // These were reaching nothing at all: payroll, the sales tax draft,
    // every card purchase on card 5337. Money left the bank and no
    // figure on any screen moved.
    if (read.what === 'cost') {
      costs.push({
        bank_txn_id: t.bank_txn_id,
        pending_bank_txn_id: t.is_pending ? t.bank_txn_id : null,
        pending_plaid_id: t.is_pending ? (t.plaid_transaction_id || null) : null,
        from_pending: !!t.is_pending,
        method: read.code === 'card_purchase' ? 'card' : 'ach',
        amount: read.amount,
        payment_date: t.posted_date,
        vendor_id: null,
        check_number: null,
        // Not accounts payable. This is the flag that lets the expense
        // line count it without double-counting a bill.
        settles_ap: false,
        category_id: read.category_name ? (catId[read.category_name.toLowerCase()] || null) : null,
        label: read.label,
        merchant: read.merchant,
        memo: (read.merchant ? read.merchant + ' — ' : '') + read.label
          + ' — read from the bank',
      });
      continue;
    }

    if (read.what === 'ask') {
      toAsk.push({
        bank_txn_id: t.bank_txn_id, date: t.posted_date,
        description: t.description, amount: read.amount,
        is_pending: !!t.is_pending,
      });
      skipped.push({
        bank_txn_id: t.bank_txn_id, date: t.posted_date,
        description: t.description, amount: money(t.amount),
        why: 'nothing on the books says whose this is',
      });
      continue;
    }

    // ---- a bill -------------------------------------------------------
    let vendorId = read.vendor ? read.vendor.vendor_id : null;
    let payment = null;

    if (read.how === 'check') {
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
          was_pending: !!t.is_pending,
        });
        spokenFor[t.bank_txn_id] = mine;
        continue;
      }

      // A check the books have never heard of. The bank saw it, so it
      // happened. Whose it was may be unknown, and that is allowed:
      // unattributed money that left is still money that left.
      if (!vendorId) vendorId = t.vendor_id || null;
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
      payment = {
        bank_txn_id: t.bank_txn_id,
        // A vendor pulling their own money is a draft, not a check.
        method: 'auto_debit',
        check_number: null,
        amount: read.amount,
        payment_date: t.posted_date,
        vendor_id: vendorId,
        memo: (read.vendor ? read.vendor.name + ' — ' : '')
          + 'taken by the vendor, read from the bank',
      };
      if (read.vendor) payment.vendor_name = read.vendor.name;
    }

    payment.settles_ap = true;
    payment.from_pending = !!t.is_pending;
    payment.pending_bank_txn_id = t.is_pending ? t.bank_txn_id : null;
    // Plaid's own id for this pending line. When it posts under a new
    // id, the posted line names this one and the payment moves across.
    payment.pending_plaid_id = t.is_pending ? (t.plaid_transaction_id || null) : null;
    payment.matched_how = read.how;

    // The bank's spelling of a vendor it could only name by the amount.
    // Learned once, so next month's draft matches on the words and does
    // not need a coincidence of figures to be recognised.
    if (read.teach_alias) learn.push(read.teach_alias);

    // Where the money lands. An exact-amount match names the invoice
    // outright; otherwise it is oldest first for that vendor.
    let parts = [];
    let leftOver = payment.amount;

    if (read.invoice && openFor[vendorId]) {
      const target = openFor[vendorId].filter(
        (x) => x.invoice_id === read.invoice.invoice_id)[0];
      if (target && money(target.balance_due) > 0) {
        const s2 = spread(payment.amount, [target]);
        parts = s2.parts;
        leftOver = s2.left_over;
      }
    }
    if (!parts.length && vendorId && openFor[vendorId] && openFor[vendorId].length) {
      const s3 = spread(payment.amount, openFor[vendorId]);
      parts = s3.parts;
      leftOver = s3.left_over;
    }

    // Keep the running balances honest within this pass, so two drafts
    // to one vendor do not both claim the same invoice.
    parts.forEach((part) => {
      const inv = (openFor[vendorId] || []).filter(
        (x) => x.invoice_id === part.invoice_id)[0];
      if (!inv) return;
      inv.amount_paid = part.paid_after;
      inv.balance_due = money(inv.total_amount - part.paid_after);
      inv.status = statusAfter(inv.total_amount, part.paid_after);
    });

    payment.allocations = parts;
    payment.left_over = leftOver;
    created.push(payment);
    if (parts.length) allocated.push({ bank_txn_id: t.bank_txn_id, parts: parts });
  }

  // ---- a second look, with what was just learned ----------------------
  //
  // The first pass works out that "ROLLING ROLLING FRITO-LA CCD" is
  // Frito-Lay, because $377.28 is exactly one open Frito-Lay invoice.
  // Two OTHER lines with that same wording are sitting in the ask queue
  // for different amounts. Making him name those by hand, when the
  // system has just this second worked out who they are, is daft.
  //
  // So anything learned in this pass is applied again to what it could
  // not read the first time. One sweep only: a second would be chasing
  // its own tail, and a thing that cannot be settled with everything
  // known belongs in front of him.
  if (learn.length && toAsk.length) {
    const ctx2 = {
      vendors: vendors,
      aliases: aliases.concat(learn.map((l) => ({
        vendor_id: l.vendor_id, alias_text: l.alias_text, squashed: squash(l.alias_text),
      }))),
      openInvoices: allOpen,
    };

    const stillAsk = [];
    for (let i = 0; i < toAsk.length; i++) {
      const a = toAsk[i];
      const t = txns.filter((x) => x.bank_txn_id === a.bank_txn_id)[0];
      if (!t) { stillAsk.push(a); continue; }

      const read = classifyLine(t, ctx2);
      if (read.what !== 'bill' || !read.vendor) { stillAsk.push(a); continue; }

      const vid = read.vendor.vendor_id;
      const payment = {
        bank_txn_id: t.bank_txn_id,
        method: t.check_number ? 'check' : 'auto_debit',
        check_number: t.check_number ? Number(t.check_number) : null,
        amount: read.amount,
        payment_date: t.posted_date,
        vendor_id: vid,
        vendor_name: read.vendor.name,
        memo: read.vendor.name + ' — taken by the vendor, read from the bank',
        settles_ap: true,
        from_pending: !!t.is_pending,
        pending_bank_txn_id: t.is_pending ? t.bank_txn_id : null,
        pending_plaid_id: t.is_pending ? (t.plaid_transaction_id || null) : null,
        matched_how: 'alias_learned_this_pass',
      };

      let parts = [];
      let leftOver = payment.amount;
      if (openFor[vid] && openFor[vid].length) {
        const s4 = spread(payment.amount, openFor[vid]);
        parts = s4.parts;
        leftOver = s4.left_over;
        parts.forEach((part) => {
          const inv = openFor[vid].filter((x) => x.invoice_id === part.invoice_id)[0];
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

    toAsk.length = 0;
    stillAsk.forEach((a) => toAsk.push(a));
  }

  return {
    ok: true,
    cutover: cutover,
    autosettle: !!(settings.data && settings.data.autosettle),
    created: created,
    linked: linked,
    allocated: allocated,
    costs: costs,
    to_ask: toAsk,
    learn: learn,
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
      costs_to_record: costs.length,
      money_in_costs: money(costs.reduce((s2, c) => s2 + c.amount, 0)),
      need_naming: toAsk.length,
      settled_by_learning: created.filter(
        (c) => c.matched_how === 'alias_learned_this_pass').length,
      aliases_to_learn: learn.length,
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
  const wrote = { payments: 0, allocations: 0, invoices: 0, cleared: 0, costs: 0, aliases: 0 };
  const problems = [];

  const acct = await supabase.from('bank_accounts')
    .select('account_id').eq('store_id', store_id).limit(1).maybeSingle();
  const accountId = acct.data ? acct.data.account_id : null;

  // Checks he wrote down, now confirmed by the bank.
  for (let i = 0; i < planned.linked.length; i++) {
    const l = planned.linked[i];
    const patch = {
      status: 'cleared',
      cleared_date: l.cleared_date,
      bank_txn_id: l.bank_txn_id,
      updated_at: now,
    };
    // It settled while the line was still pending; the line has now
    // posted. It is finally real, so the pending marks come off.
    if (l.finalise) {
      patch.from_pending = false;
      patch.pending_plaid_id = null;
      patch.pending_bank_txn_id = null;
    }
    const upd = await supabase.from('payments').update(patch)
      .eq('payment_id', l.payment_id).eq('store_id', store_id);
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
      // On the statement means it happened. A line still pending is
      // committed but not final, so it is outstanding rather than
      // cleared -- and it still settles its invoice, because the money
      // is spoken for and telling him to pay it again is the worse
      // error by far.
      status: p.from_pending ? 'outstanding' : 'cleared',
      cleared_date: p.from_pending ? null : p.payment_date,
      issued_at: new Date(p.payment_date + 'T12:00:00Z').toISOString(),
      bank_txn_id: p.bank_txn_id,
      pending_bank_txn_id: p.pending_bank_txn_id || null,
      pending_plaid_id: p.pending_plaid_id || null,
      from_pending: !!p.from_pending,
      created_from_bank: true,
      settles_ap: true,
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

  // ---- costs with no invoice behind them -----------------------------
  //
  // Payroll, the tax drafts, every card purchase on card 5337. These
  // never reached any figure before. They go in as payments that settle
  // no bill, which is exactly what they are, and settles_ap = false is
  // what lets the expense line count them without double-counting a
  // delivery that was already costed.
  for (let i = 0; i < (planned.costs || []).length; i++) {
    const c = planned.costs[i];
    const row = {
      store_id: store_id,
      account_id: accountId,
      method: c.method,
      payment_date: c.payment_date,
      amount: c.amount,
      vendor_id: null,
      check_number: null,
      memo: c.memo,
      status: 'cleared',
      cleared_date: c.payment_date,
      issued_at: new Date(c.payment_date + 'T12:00:00Z').toISOString(),
      bank_txn_id: c.bank_txn_id,
      pending_bank_txn_id: c.pending_bank_txn_id,
      from_pending: c.from_pending,
      created_from_bank: true,
      settles_ap: false,
      category_id: c.category_id,
      qb_synced: false,
    };
    const ins = await supabase.from('payments').insert(row).select('payment_id').single();
    if (ins.error) {
      if (/duplicate key|unique/i.test(ins.error.message)) continue;
      problems.push('cost for ' + c.bank_txn_id + ': ' + ins.error.message);
      continue;
    }
    wrote.costs += 1;
  }

  // ---- what the bank calls each vendor --------------------------------
  //
  // Proved by an exact amount this time; matched on the words next time.
  // This is the part that compounds: every month the system needs fewer
  // coincidences to know who it is looking at.
  for (let i = 0; i < (planned.learn || []).length; i++) {
    const a = planned.learn[i];
    const sq = squash(a.alias_text);
    if (!sq || sq.length < 4) continue;
    const ins = await supabase.from('vendor_aliases').insert({
      store_id: store_id,
      vendor_id: a.vendor_id,
      alias_text: a.alias_text,
      squashed: sq,
      source: 'learned',
    });
    if (!ins.error) wrote.aliases += 1;
  }

  // The bank lines now have an answer.
  const answered = planned.created.map((p) => p.bank_txn_id)
    .concat(planned.linked.map((l) => l.bank_txn_id))
    .concat((planned.costs || []).map((c) => c.bank_txn_id));
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

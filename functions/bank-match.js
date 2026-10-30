// Netlify Function: bank-match
// Put the whole bank statement next to the books and say what ties up.
//
// Route: /.netlify/functions/bank-match
//   GET  ?store_id=store1                 -> preview: changes nothing
//   POST { action: 'preview' }            -> same, explicitly
//   POST { action: 'apply' }              -> writes the decisions
//   POST { action: 'teach', pattern, kind, ... }  -> name a line for ever
//   POST { action: 'backfill_checks' }    -> bring cleared checks into the books
//
// ---------------------------------------------------------------------
// Why preview is the default
//
// This touches 2,660 rows of a real company's books. The default verb of
// anything that can do that should be "show me", not "do it". So a GET
// reads and decides and returns, and writes nothing at all; the writing
// needs an explicit apply. Raz can look at what it intends to do, and if
// it is wrong, nothing has happened yet.
//
// ---------------------------------------------------------------------
// Two things that would be easy to get wrong here
//
// 1. Supabase returns 1,000 rows by default. There are 2,660. A version
//    of this that forgot to page would quietly match the first thousand
//    and report success, and the report would be wrong in the direction
//    that looks like progress.
//
// 2. 2,660 individual updates is 2,660 round trips, and this function has
//    seconds. So decisions that share a verdict are written together in
//    one statement per group -- which turns the whole year into about
//    twenty queries.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { classify } = require('./lib/bankrules');
const { index, matchAll } = require('./lib/matcher');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUSINESS_TZ = 'America/Los_Angeles';
const pacificToday = () => new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Supabase caps a reply at 1,000 rows. Ask in pages until a short page
// says there is no more.
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
    // A runaway guard. If this ever trips, something is wrong upstream
    // and looping forever would be the worse failure.
    if (rows.length > 100000) return rows;
  }
}

// Updates that say the same thing go out together.
async function updateGrouped(groups) {
  const CHUNK = 150;
  let written = 0;
  const keys = Object.keys(groups);
  for (let g = 0; g < keys.length; g++) {
    const group = groups[keys[g]];
    const ids = group.ids;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const res = await supabase
        .from('bank_transactions')
        .update(group.patch)
        .in('bank_txn_id', slice);
      if (res.error) throw new Error('write failed: ' + res.error.message);
      written += slice.length;
    }
  }
  return written;
}

/**
 * Read everything the decision needs, and decide. Writes nothing.
 */
async function decide(store_id, opts) {
  const only = (opts && opts.only) || 'unmatched';

  const [txns, payments, invoices, vendors, rules] = await Promise.all([
    all('bank_transactions',
      'bank_txn_id, posted_date, description, amount, check_number, match_status, is_pending',
      (q) => {
        q = q.eq('store_id', store_id).order('posted_date', { ascending: false });
        // Already-reconciled lines are settled history and are left alone.
        if (only === 'unmatched') q = q.in('match_status', ['unmatched', 'recognized']);
        return q;
      }),
    all('payments',
      'payment_id, check_number, amount, vendor_id, payment_date, status, method',
      (q) => q.eq('store_id', store_id)),
    all('invoices',
      'invoice_id, vendor_id, invoice_number, total_amount, balance_due, status, due_date',
      (q) => q.eq('store_id', store_id)),
    all('vendors', 'vendor_id, name, dba, default_category_id',
      (q) => q.eq('store_id', store_id).eq('active', true)),
    all('bank_rules', 'rule_id, pattern, kind, code, label, vendor_id, category_id',
      (q) => q.eq('store_id', store_id)),
  ]);

  const vlist = vendors.map((v) => ({
    vendor_id: v.vendor_id,
    name: v.name,
    aliases: v.dba ? [v.dba] : [],
  }));
  const catOf = {};
  vendors.forEach((v) => { if (v.default_category_id) catOf[v.vendor_id] = v.default_category_id; });

  const idx = index(payments, invoices);
  const result = matchAll(txns, {
    byCheck: idx.byCheck,
    byVendor: idx.byVendor,
    rules: rules,
    classify: (d, a) => classify(d, a, vlist),
  });

  // A line that names a vendor inherits that vendor's category, so the
  // expense lands in the right place on the P&L without being told twice.
  result.decisions.forEach((d) => {
    if (!d.category_id && d.vendor_id && catOf[d.vendor_id]) {
      d.category_id = catOf[d.vendor_id];
    }
  });

  return { txns: txns, decisions: result.decisions, tally: result.tally,
           payments: payments };
}

/**
 * The unnamed lines, gathered by description.
 *
 * 2,660 lines is not a list anybody reads. But the unknowns repeat: the
 * same handful of descriptions over and over. Grouped, a year of mystery
 * usually turns out to be fifteen or twenty things, and naming one names
 * all of its lines at once.
 */
function unknownGroups(txns, decisions) {
  const byId = {};
  txns.forEach((t) => { byId[t.bank_txn_id] = t; });

  const groups = {};
  decisions.forEach((d) => {
    if (d.status !== 'unmatched' || d.kind !== 'unknown') return;
    const t = byId[d.bank_txn_id];
    if (!t) return;
    // Trailing reference numbers differ line to line; the name does not.
    const key = String(t.description || '')
      .toUpperCase()
      .replace(/\d{4,}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const g = groups[key] || (groups[key] = {
      pattern: key, example: t.description, count: 0,
      total_out: 0, total_in: 0, first: t.posted_date, last: t.posted_date,
    });
    g.count += 1;
    const a = money(t.amount);
    if (a < 0) g.total_out = money(g.total_out + Math.abs(a));
    else g.total_in = money(g.total_in + a);
    if (t.posted_date < g.first) g.first = t.posted_date;
    if (t.posted_date > g.last) g.last = t.posted_date;
  });

  return Object.keys(groups)
    .map((k) => groups[k])
    .sort((a, b) => (b.total_out + b.total_in) - (a.total_out + a.total_in));
}

exports.handler = safely('bank-match', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { body = {}; }
  }
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  const action = body.action || q.action || (event.httpMethod === 'GET' ? 'preview' : 'preview');

  // ---------------- teach --------------------------------------------
  // He names a line once. Everything that looks like it is named from
  // now on, including lines that have not arrived yet.
  if (action === 'teach') {
    const pattern = String(body.pattern || '').trim();
    if (!pattern) return json(400, { error: 'Say which description to recognise.' });
    const kind = String(body.kind || '').trim();
    const ALLOWED = ['transfer', 'income', 'expense', 'settles', 'unknown'];
    if (ALLOWED.indexOf(kind) === -1) {
      return json(400, {
        error: 'kind has to be one of: ' + ALLOWED.join(', ') + '.',
      });
    }
    const row = {
      store_id: store_id,
      pattern: pattern,
      kind: kind,
      code: body.code || 'taught',
      label: body.label || null,
      vendor_id: body.vendor_id || null,
      category_id: body.category_id || null,
      created_by: auth.user && auth.user.email ? auth.user.email : null,
    };

    // Looked up and then written, rather than upserted.
    //
    // The unique index on this table is (store_id, upper(pattern)) -- an
    // EXPRESSION index, so that naming a line is case-insensitive. ON
    // CONFLICT cannot use an expression index through PostgREST: there is
    // no way to spell "upper(pattern)" as a conflict target. An upsert
    // here fails with "there is no unique or exclusion constraint
    // matching the ON CONFLICT specification", which sounds like a
    // missing index and is really a mismatched one.
    //
    // So: find it the way the index finds it, then update or insert. Two
    // round trips instead of one, for something a person does a handful
    // of times, and it works against the index that actually exists.
    const found = await supabase
      .from('bank_rules')
      .select('rule_id')
      .eq('store_id', store_id)
      .ilike('pattern', pattern)
      .maybeSingle();
    if (found.error) return json(500, { error: found.error.message });

    let res;
    if (found.data) {
      res = await supabase
        .from('bank_rules')
        .update(row)
        .eq('rule_id', found.data.rule_id)
        .select('rule_id, pattern, kind, label');
    } else {
      res = await supabase
        .from('bank_rules')
        .insert(row)
        .select('rule_id, pattern, kind, label');
    }
    if (res.error) return json(500, { error: res.error.message });
    return json(200, {
      ok: true,
      rule: (res.data || [])[0] || row,
      message: 'Every line reading "' + pattern + '" is ' + kind + ' from now on.',
    });
  }

  // ---------------- preview / apply -----------------------------------
  if (action === 'preview' || action === 'apply') {
    const d = await decide(store_id, { only: body.only || q.only || 'unmatched' });

    const payload = {
      ok: true,
      applied: false,
      looked_at: d.tally.total,
      matched: d.tally.matched,
      recognized: d.tally.recognized,
      still_unknown: d.tally.unmatched,
      exceptions: d.tally.exceptions,
      checks_cleared_not_in_books: d.tally.checks_not_in_books,
      checks_cleared_not_in_books_value: d.tally.checks_not_in_books_value,
      unknown_money_out: d.tally.unknown_value_out,
      unknown_money_in: d.tally.unknown_value_in,
      to_name: unknownGroups(d.txns, d.decisions).slice(0, 40),
      problems: d.decisions
        .filter((x) => x.exception && x.exception.severity !== 'info')
        .slice(0, 50)
        .map((x) => ({
          bank_txn_id: x.bank_txn_id,
          severity: x.exception.severity,
          what: x.exception.what,
          detail: x.exception.detail,
        })),
    };

    if (action === 'preview') {
      payload.message = 'Nothing has been changed. This is what applying would do.';
      return json(200, payload);
    }

    // ---- write ------------------------------------------------------
    const groups = {};
    const singles = [];
    const now = new Date().toISOString();

    d.decisions.forEach((x) => {
      const patch = {
        match_status: x.status,
        kind: x.kind,
        code: x.code,
        vendor_id: x.vendor_id || null,
        category_id: x.category_id || null,
        match_note: x.note || null,
        matched_at: now,
      };
      if (x.matched_id) {
        // Each of these carries its own id, so they go one at a time --
        // and there are few of them, because few checks are in the books.
        patch.matched_type = x.matched_type;
        patch.matched_id = x.matched_id;
        singles.push({ id: x.bank_txn_id, patch: patch, decision: x });
        return;
      }
      patch.matched_type = null;
      patch.matched_id = null;
      const key = JSON.stringify([patch.match_status, patch.kind, patch.code,
        patch.vendor_id, patch.category_id, patch.match_note]);
      const g = groups[key] || (groups[key] = { patch: patch, ids: [] });
      g.ids.push(x.bank_txn_id);
    });

    let written = await updateGrouped(groups);

    for (let i = 0; i < singles.length; i++) {
      const s = singles[i];
      const res = await supabase
        .from('bank_transactions')
        .update(s.patch)
        .eq('bank_txn_id', s.id);
      if (res.error) return json(500, { error: res.error.message, where: 'matched row' });
      written += 1;

      // A matched check is a cleared check. The outstanding list is only
      // useful if things leave it.
      if (s.decision.matched_type === 'payment') {
        await supabase
          .from('payments')
          .update({ status: 'cleared', cleared_date: pacificToday() })
          .eq('payment_id', s.decision.matched_id)
          .in('status', ['outstanding', 'issued', 'approved']);
      }
    }

    // Anything the books and the bank disagree about goes somewhere he
    // will see it, not just into this reply.
    const raise = d.decisions
      .filter((x) => x.exception && x.exception.severity !== 'info')
      .map((x) => ({
        store_id: store_id,
        severity: x.exception.severity,
        code: x.exception.what,
        message: x.exception.detail,
        entity_type: 'bank_transaction',
        entity_id: x.bank_txn_id,
        raised_by: 'bank-match',
        suggested_action: x.exception.what === 'check_amount_differs'
          ? 'Pull the cleared check image from the bank and compare it with what was written.'
          : 'Open the line and say which bill it paid.',
      }));
    if (raise.length) {
      const ex = await supabase.from('exceptions').insert(raise);
      // An exception that cannot be filed must not sink the whole run;
      // the matching itself is already done and correct.
      if (ex.error) payload.exception_note = 'Could not file exceptions: ' + ex.error.message;
    }

    payload.applied = true;
    payload.rows_written = written;
    payload.message = d.tally.matched + ' tied to the books, '
      + d.tally.recognized + ' recognised, '
      + d.tally.unmatched + ' still to name.';
    return json(200, payload);
  }

  // ---------------- backfill the checks --------------------------------
  // A year of checks was written through QuickBooks, so the bank knows
  // about them and this system does not. The bank is evidence: the money
  // left, on that date, as that check number, for that amount. Those are
  // facts and they can be written down.
  //
  // What the bank does NOT say is who the check was to. So the payee is
  // left empty rather than guessed, and these arrive as cleared checks
  // waiting to be named -- which is true, and useful, and not a fiction.
  if (action === 'backfill_checks') {
    const d = await decide(store_id, { only: 'unmatched' });
    const byId = {};
    d.txns.forEach((t) => { byId[t.bank_txn_id] = t; });

    const have = {};
    d.payments.forEach((p) => {
      if (p.check_number != null) have[String(Number(p.check_number))] = 1;
    });

    const acct = await supabase
      .from('bank_accounts')
      .select('account_id')
      .eq('store_id', store_id)
      .limit(1)
      .maybeSingle();

    const rows = [];
    const seen = {};
    d.decisions.forEach((x) => {
      if (!x.exception || x.exception.what !== 'check_not_in_books') return;
      const t = byId[x.bank_txn_id];
      if (!t || t.check_number == null) return;
      const key = String(Number(t.check_number));
      if (have[key] || seen[key]) return;
      seen[key] = 1;
      rows.push({
        store_id: store_id,
        account_id: acct.data ? acct.data.account_id : null,
        method: 'check',
        status: 'cleared',
        check_number: Number(t.check_number),
        amount: Math.abs(money(t.amount)),
        payment_date: t.posted_date,
        cleared_date: t.posted_date,
        bank_txn_id: t.bank_txn_id,
        memo: 'Brought in from the bank statement. Payee not yet named.',
      });
    });

    if (!rows.length) {
      return json(200, { ok: true, created: 0,
        message: 'Every cleared check is already in the books.' });
    }

    if (body.confirm !== true) {
      const total = rows.reduce((s, r) => money(s + r.amount), 0);
      return json(200, {
        ok: true,
        created: 0,
        would_create: rows.length,
        would_total: total,
        oldest: rows.reduce((a, r) => (r.payment_date < a ? r.payment_date : a), rows[0].payment_date),
        newest: rows.reduce((a, r) => (r.payment_date > a ? r.payment_date : a), rows[0].payment_date),
        message: 'This would add ' + rows.length + ' cleared checks worth $'
          + total.toFixed(2) + ' to your books, with the payee left blank for '
          + 'you to fill in. Send it again with confirm to go ahead.',
      });
    }

    let made = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const slice = rows.slice(i, i + 200);
      const res = await supabase.from('payments').insert(slice);
      if (res.error) return json(500, { error: res.error.message, created: made });
      made += slice.length;
    }

    return json(200, {
      ok: true,
      created: made,
      message: made + ' checks brought into the books from the bank. '
        + 'Run matching again to tie them to their bank lines.',
    });
  }

  return json(400, { error: 'Unknown action: ' + action });
});

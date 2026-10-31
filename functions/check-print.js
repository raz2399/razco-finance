// Netlify Function: check-print
// Printing checks, so QuickBooks is not needed to do it.
//
//   GET  ?store_id=store1            -> what is waiting, and which numbers
//   POST { payment_ids, start_number } -> assign numbers, mark issued
//
// ---------------------------------------------------------------------
// What this does and deliberately does not do
//
// It prints the VARIABLE part of a check onto pre-printed stock. The
// MICR line along the bottom -- routing number, account number, check
// number in magnetic ink -- is already on the paper. Printing MICR
// ourselves would mean a magnetic toner cartridge, an exact font, and a
// bank that may reject the result; buying stock avoids all of it, and
// it is what QuickBooks does too.
//
// ---------------------------------------------------------------------
// The number is the dangerous part
//
// A check number is a serial number on a piece of paper that has already
// been printed. Assign one that is already used and two different checks
// carry the same number: the bank may pay both, the reconciliation
// matches the wrong one, and the only trace is a duplicate in a
// statement months later.
//
// So nothing is assumed. Every number about to be used is checked
// against every number ever seen -- in the books AND on the bank
// statement -- and a single collision refuses the whole run rather than
// printing the rest and hoping.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { amountInWords, amountInFigures, fill } = require('./lib/checkwords');
const { mint } = require('./lib/sheettoken');

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

// Every check number this store has ever used, from both places that
// know about one.
async function numbersUsed(store_id) {
  const [pays, bank] = await Promise.all([
    all('payments', 'check_number, status, payment_date',
      (q) => q.eq('store_id', store_id).not('check_number', 'is', null)),
    all('bank_transactions', 'check_number, posted_date',
      (q) => q.eq('store_id', store_id).not('check_number', 'is', null)),
  ]);
  // The value is the latest date that number was seen, because which
  // book is CURRENT is a question about recency, not about volume.
  const used = {};
  const note = (n, date) => {
    const k = Number(n);
    const d = String(date || '');
    if (!used[k] || d > used[k]) used[k] = d || used[k] || '';
  };
  pays.forEach((p) => {
    // A voided check number is spent. The paper exists and is ruined;
    // nothing else may ever carry that number.
    note(p.check_number, p.payment_date);
  });
  bank.forEach((b) => { note(b.check_number, b.posted_date); });
  return used;
}

// Which books of checks are in use, so the suggestion is not a guess.
// Razco runs more than one series at once -- 6000s and 9000s -- and a
// default of 1000 would print numbers from neither.
function seriesOf(used) {
  const by = {};
  Object.keys(used).forEach((k) => {
    const n = Number(k);
    const date = used[k] || '';
    const s = Math.floor(n / 1000) * 1000;
    const b = by[s] || (by[s] = {
      series: s, count: 0, lowest: n, highest: n, last_used: date,
    });
    b.count += 1;
    if (n < b.lowest) b.lowest = n;
    if (n > b.highest) b.highest = n;
    if (date > b.last_used) b.last_used = date;
  });
  return Object.keys(by).map((k) => {
    const b = by[k];
    b.next_free = b.highest + 1;
    b.left_in_book = (b.series + 999) - b.highest;
    return b;
  // Most recently used first. Razco runs two books at once -- 6000s and
  // 9000s -- and the one with more checks in it is not necessarily the
  // one in the printer this morning. Sorting by volume picked the wrong
  // book; sorting by the last date a number was seen picks the one
  // actually in use. Ties break on the higher series so the answer is
  // at least stable.
  }).sort((a, b) => (a.last_used === b.last_used
    ? b.series - a.series
    : (a.last_used < b.last_used ? 1 : -1)));
}

exports.handler = safely('check-print', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { body = {}; }
  }
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  const acctRes = await supabase
    .from('bank_accounts')
    .select('account_id, nickname, next_check_number, check_offset_x, check_offset_y, check_layout')
    .eq('store_id', store_id)
    .limit(1)
    .maybeSingle();
  if (acctRes.error) return json(500, { error: acctRes.error.message });
  const acct = acctRes.data;

  // ---------------- what is waiting to be printed ----------------------
  if (event.httpMethod === 'GET') {
    const [waiting, vendors, used] = await Promise.all([
      all('payments',
        'payment_id, vendor_id, amount, payment_date, memo, status, method, check_number',
        (p) => p.eq('store_id', store_id).eq('method', 'check')
          .is('check_number', null)
          .in('status', ['draft', 'pending_approval', 'approved'])),
      all('vendors', 'vendor_id, name, address_line1, address_line2, city, state, postal_code',
        (p) => p.eq('store_id', store_id)),
      numbersUsed(store_id),
    ]);

    const vById = {};
    vendors.forEach((v) => { vById[v.vendor_id] = v; });

    const books = seriesOf(used);

    return json(200, {
      ok: true,
      account: acct ? {
        nickname: acct.nickname,
        layout: acct.check_layout,
        offset_x: Number(acct.check_offset_x),
        offset_y: Number(acct.check_offset_y),
        stored_next: acct.next_check_number,
      } : null,
      // What the system thinks comes next, and what the evidence says.
      // Shown apart on purpose: the stored figure was 1000 while the
      // real checks were in the 6000s and 9000s, and silently printing
      // 1000 would have been worse than asking.
      books: books,
      suggested_next: books.length ? books[0].next_free : null,
      // A book runs out at x999. Worth knowing before a payment run,
      // not halfway through one.
      nearly_out: books.filter((b) => b.left_in_book <= 25),
      waiting: waiting.map((p) => {
        const v = vById[p.vendor_id] || {};
        return {
          payment_id: p.payment_id,
          vendor_id: p.vendor_id,
          payee: v.name || '(no vendor named)',
          has_address: !!v.address_line1,
          amount: money(p.amount),
          payment_date: p.payment_date,
          memo: p.memo || '',
          status: p.status,
          // Refused here rather than at the printer.
          printable: amountInWords(p.amount) !== null && money(p.amount) > 0,
        };
      }),
      count: waiting.length,
    });
  }

  // ---------------- assign numbers and mark them issued ----------------
  const ids = body.payment_ids;
  if (!Array.isArray(ids) || !ids.length) {
    return json(400, { error: 'Which checks?' });
  }
  const start = Number(body.start_number);
  if (!(start > 0 && start < 100000000)) {
    return json(400, { error: 'Give the number of the first check in the printer.' });
  }

  const [rows, vendors, used] = await Promise.all([
    all('payments',
      'payment_id, vendor_id, amount, payment_date, memo, status, method, check_number',
      (p) => p.eq('store_id', store_id).in('payment_id', ids)),
    all('vendors', 'vendor_id, name, address_line1, address_line2, city, state, postal_code',
      (p) => p.eq('store_id', store_id)),
    numbersUsed(store_id),
  ]);

  if (rows.length !== ids.length) {
    return json(400, { error: 'Some of those payments are not on file.' });
  }
  const already = rows.filter((r) => r.check_number != null);
  if (already.length) {
    return json(409, {
      error: already.length + ' of those already have a check number. '
        + 'Reprinting would put two numbers on one payment.',
    });
  }
  const notCheck = rows.filter((r) => r.method !== 'check');
  if (notCheck.length) {
    return json(400, { error: 'Only checks can be printed.' });
  }

  // Keep the order stable so the numbers on the paper match the order
  // they come out of the printer.
  const ordered = ids.map((id) => rows.filter((r) => r.payment_id === id)[0]);

  // Every number this run would use, checked before any of them is
  // written. A collision anywhere refuses the whole run.
  const wanted = [];
  for (let i = 0; i < ordered.length; i++) wanted.push(start + i);
  const clash = wanted.filter((n) => used[n]);
  if (clash.length) {
    return json(409, {
      error: 'Check number' + (clash.length > 1 ? 's ' : ' ') + clash.slice(0, 8).join(', ')
        + (clash.length > 8 ? ' and others' : '')
        + ' ' + (clash.length > 1 ? 'have' : 'has') + ' been used before. '
        + 'Nothing was printed. Start from a number that has not been used.',
      clashes: clash,
    });
  }

  const vById = {};
  vendors.forEach((v) => { vById[v.vendor_id] = v; });

  // Refuse anything whose amount cannot be written out, before issuing a
  // single number. A check with a blank written line is not a check.
  const unwritable = ordered.filter((r) => amountInWords(r.amount) === null || money(r.amount) <= 0);
  if (unwritable.length) {
    return json(400, {
      error: unwritable.length + ' of those have an amount that cannot be written on a '
        + 'check. Nothing was printed.',
    });
  }

  const today = pacificToday();
  const printed = [];
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i];
    const number = start + i;
    const v = vById[p.vendor_id] || {};

    const upd = await supabase.from('payments').update({
      check_number: number,
      status: 'outstanding',
      issued_at: new Date().toISOString(),
      payment_date: p.payment_date || today,
      updated_at: new Date().toISOString(),
    }).eq('payment_id', p.payment_id).is('check_number', null);

    if (upd.error) {
      return json(500, {
        error: upd.error.message,
        printed_so_far: printed.map((x) => x.check_number),
        where: 'assigning check numbers',
      });
    }

    const amount = money(p.amount);
    printed.push({
      payment_id: p.payment_id,
      check_number: number,
      date: p.payment_date || today,
      payee: v.name || '',
      address: [v.address_line1, v.address_line2,
        [v.city, v.state].filter(Boolean).join(', '), v.postal_code]
        .filter(Boolean),
      amount: amount,
      amount_figures: amountInFigures(amount),
      amount_words: fill(amountInWords(amount), 95),
      memo: p.memo || '',
    });
  }

  if (acct) {
    await supabase.from('bank_accounts')
      .update({ next_check_number: start + ordered.length })
      .eq('account_id', acct.account_id);
  }

  // A link the phone can hand to Safari, which is how an iPhone prints.
  // Signed, scoped to this run, dead in ten minutes -- a browser opened
  // from the app carries no session, and the alternatives are an open
  // URL or the session token in browser history.
  const sheetPath = '/.netlify/functions/check-sheet?t='
    + encodeURIComponent(mint(store_id, printed.map((p) => p.payment_id)))
    + '&dx=' + (acct ? Number(acct.check_offset_x) : 0)
    + '&dy=' + (acct ? Number(acct.check_offset_y) : 0);

  return json(200, {
    ok: true,
    printed: printed,
    count: printed.length,
    sheet_url: sheetPath,
    next_check_number: start + ordered.length,
    layout: acct ? acct.check_layout : 'top',
    offset_x: acct ? Number(acct.check_offset_x) : 0,
    offset_y: acct ? Number(acct.check_offset_y) : 0,
    message: printed.length + ' check' + (printed.length === 1 ? '' : 's')
      + ' numbered ' + printed[0].check_number
      + (printed.length > 1 ? ' to ' + printed[printed.length - 1].check_number : '')
      + '. They are marked outstanding and will clear themselves off when the '
      + 'bank takes them.',
  });
});

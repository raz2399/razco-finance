// Tests the vendor ledger.
//
// The thing it has to get right: a running balance is only meaningful in
// date order. Sort by amount and add up the column underneath and you get
// a number that means nothing, which is worse than no number because it
// looks like one.

const path = require('path');
const Module = require('module');
require('./stub-guard');

const DB = {
  vendors: [
    { vendor_id: 'v1', store_id: 'store1', name: 'Sysco', payment_type: 'charge_account',
      terms_code: 'net15', terms_days: 15, account_number: null, contact_phone: null, active: true },
    { vendor_id: 'v2', store_id: 'store1', name: 'M & J Seafood Co., Inc.', payment_type: 'check',
      terms_code: 'net7', terms_days: 7, account_number: null, contact_phone: null, active: true },
    { vendor_id: 'v3', store_id: 'store1', name: 'Tadin', payment_type: 'unknown',
      terms_code: null, terms_days: null, account_number: null, contact_phone: null, active: true },
  ],
  vendor_aliases: [{ vendor_id: 'v2', alias_text: 'M&J SEA FOOD' }],
  invoices: [
    { invoice_id: 'i1', store_id: 'store1', vendor_id: 'v1', invoice_number: 'QB-OPEN',
      invoice_date: '2026-10-28', received_date: '2026-10-28', due_date: null,
      total_amount: 20508.53, amount_paid: 0, balance_due: 20508.53, status: 'approved',
      payment_type: 'charge_account', notes: 'Opening balance carried from QuickBooks',
      created_at: '2026-10-29T03:00:00Z' },
    { invoice_id: 'i2', store_id: 'store1', vendor_id: 'v1', invoice_number: '9001',
      invoice_date: '2026-10-05', received_date: '2026-10-05', due_date: '2026-10-20',
      total_amount: 1000, amount_paid: 1000, balance_due: 0, status: 'paid',
      payment_type: 'charge_account', notes: null, created_at: '2026-10-05T10:00:00Z' },
    { invoice_id: 'i3', store_id: 'store1', vendor_id: 'v1', invoice_number: '10',
      invoice_date: '2026-10-12', received_date: '2026-10-12', due_date: '2026-10-27',
      total_amount: 500, amount_paid: 0, balance_due: 500, status: 'approved',
      payment_type: 'charge_account', notes: null, created_at: '2026-10-12T10:00:00Z' },
  ],
  payments: [
    { payment_id: 'p1', store_id: 'store1', vendor_id: 'v1', method: 'check',
      payment_date: '2026-10-19', amount: 1000, check_number: 9500, memo: null,
      status: 'cleared', cleared_date: '2026-10-21', created_at: '2026-10-19T10:00:00Z' },
    { payment_id: 'p2', store_id: 'store1', vendor_id: 'v1', method: 'check',
      payment_date: '2026-10-26', amount: 250, check_number: 9600, memo: null,
      status: 'outstanding', cleared_date: null, created_at: '2026-10-26T10:00:00Z' },
  ],
  payment_allocations: [{ payment_id: 'p1', invoice_id: 'i2', amount: 1000 }],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB12';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB12 = {
  id: 'MOCK_SB12', filename: 'MOCK_SB12', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { handler } = require(path.join(__dirname, '..', 'functions', 'vendor-ledger.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const GET = (params) => handler({
  httpMethod: 'GET', headers: { Authorization: 'Bearer t' },
  queryStringParameters: Object.assign({ store_id: 'store1' }, params || {}),
});

(async () => {
  console.log('Finding a vendor');
  let b = JSON.parse((await GET({ q: 'sys' })).body);
  check('one match', b.count, 1);
  check('the right one', b.vendors[0].name, 'Sysco');
  check('with what is owed', b.vendors[0].owed, 20508.53 + 500);

  b = JSON.parse((await GET({ q: 'm&j' })).body);
  check('found by the spelling on the paper', b.count, 1);
  check('offered under its real name', b.vendors[0].name, 'M & J Seafood Co., Inc.');

  b = JSON.parse((await GET({})).body);
  check('no search, all of them', b.count, 3);
  checkTrue('the ones he owes come first', b.vendors[0].owed > 0);
  check('and the total is the total', b.total_owed, 21008.53);

  console.log('\nA vendor with nothing against him');
  const tadin = JSON.parse((await GET({ q: 'tadin' })).body).vendors[0];
  check('owes nothing', tadin.owed, 0);
  check('and his payment type is not invented', tadin.pay_method, null);

  console.log('\nThe ledger: lines, not a total');
  b = JSON.parse((await GET({ vendor_id: 'v1' })).body);
  check('every line is there', b.count, 5);
  checkTrue('invoices and payments together',
    b.entries.some((e) => e.kind === 'invoice') && b.entries.some((e) => e.kind === 'payment'));

  console.log('\nThe running balance');
  // In date order: 9001 +1000, 10 +500, check 9500 -1000, check 9600 -250,
  // QB-OPEN +20508.53. Ending at 20758.53.
  check('ends where it should', b.totals.owed, 20758.53);
  check('charged', b.totals.charged, 20508.53 + 1000 + 500);
  check('paid', b.totals.paid, 1250);
  checkTrue('charged minus paid is the balance',
    Math.round((b.totals.charged - b.totals.paid) * 100) / 100 === b.totals.owed);

  console.log('\nSorted by amount, the balance still means something');
  const byAmount = JSON.parse((await GET({ vendor_id: 'v1', sort: 'amount', dir: 'desc' })).body);
  check('the same ending balance', byAmount.totals.owed, 20758.53);
  check('biggest first', byAmount.entries[0].charge, 20508.53);
  // This is the trap: the balance_after on each row must still be the
  // balance as of that row's DATE, not a sum of the rows above it in
  // whatever order the screen happens to be showing.
  const qbRow = byAmount.entries.filter((e) => e.opening)[0];
  const sameRowByDate = b.entries.filter((e) => e.opening)[0];
  check('and each line keeps the balance from its own date',
    qbRow.balance_after, sameRowByDate.balance_after);

  console.log('\nSorting by invoice number');
  const byNum = JSON.parse((await GET({ vendor_id: 'v1', sort: 'number', dir: 'asc' })).body);
  const nums = byNum.entries.map((e) => e.number).filter(Boolean);
  // 9 before 10 — numbers that are numbers sort as numbers, not as text.
  checkTrue('10 comes before 9001', nums.indexOf('10') < nums.indexOf('9001'), nums.join(','));

  console.log('\nSorting by date');
  const asc = JSON.parse((await GET({ vendor_id: 'v1', sort: 'date', dir: 'asc' })).body);
  check('oldest first', asc.entries[0].date, '2026-10-05');
  const desc = JSON.parse((await GET({ vendor_id: 'v1', sort: 'date', dir: 'desc' })).body);
  check('newest first', desc.entries[0].date, '2026-10-28');

  console.log('\nBetween two dates');
  const window_ = JSON.parse((await GET({ vendor_id: 'v1', from: '2026-10-10', to: '2026-10-20' })).body);
  check('only what falls inside', window_.count, 2);
  checkTrue('but the balance is still the real one',
    window_.totals.owed === 20758.53,
    'a date filter changes what is shown, never what is owed');

  console.log('\nOnly what is still open');
  const openOnly = JSON.parse((await GET({ vendor_id: 'v1', include: 'open' })).body);
  check('two invoices', openOnly.count, 2);
  checkTrue('and the paid one is gone',
    !openOnly.entries.some((e) => e.number === '9001'));

  console.log('\nA check written but not cashed');
  const uncashed = b.entries.filter((e) => e.kind === 'payment' && !e.settled);
  check('counted', b.totals.checks_not_cashed, 1);
  check('for its amount', b.totals.checks_not_cashed_total, 250);
  check('and named', uncashed[0].number, '9600');

  console.log('\nWhat came from QuickBooks is labelled as such');
  const qb = b.entries.filter((e) => e.opening)[0];
  checkTrue('marked', !!qb);
  check('and not called an invoice', qb.label, 'Opening balance from QuickBooks');
  check('kept separate in the totals', b.totals.from_quickbooks, 20508.53);
  checkTrue('so it is never mistaken for a bill anyone has seen',
    b.totals.from_quickbooks < b.totals.owed);

  console.log('\nA vendor that is not his');
  const nope = await handler({
    httpMethod: 'GET', headers: { Authorization: 'Bearer t' },
    queryStringParameters: { store_id: 'store2', vendor_id: 'v1' },
  });
  check('refused', nope.statusCode, 403);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

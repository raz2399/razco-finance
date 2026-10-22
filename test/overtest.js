// Tests overview.js against real Razco numbers (week of Mon 2026-09-07).
// No network, no secrets: a mock Supabase returns exactly what the live
// database returns for that week, so the arithmetic is what gets checked.

const Module = require('module');
const path = require('path');

const DATA = {
  tender_types: [
    { tender_id: '1', description: 'CASH', bucket: 'cash', sort_order: 1 },
    { tender_id: '2', description: 'CREDIT', bucket: 'card', sort_order: 2 },
    { tender_id: '3', description: 'DEBIT', bucket: 'card', sort_order: 3 },
    { tender_id: '4', description: 'EBT Cash', bucket: 'card', sort_order: 4 },
    { tender_id: '5', description: 'EBT Food Stamp', bucket: 'card', sort_order: 5 },
    { tender_id: '6', description: 'eWIC', bucket: 'card', sort_order: 6 },
    { tender_id: '7', description: 'Check', bucket: 'check', sort_order: 7 },
    { tender_id: '8', description: 'VENDOR COUPON', bucket: 'other', sort_order: 8 },
    { tender_id: '9', description: 'GIFT CARD', bucket: 'card', sort_order: 9 },
  ],
  tender_daily: [
    { store_id: 'store1', business_date: '2026-09-07', tender_id: '1', tender_amount: 9752.44 },
    { store_id: 'store1', business_date: '2026-09-07', tender_id: '2', tender_amount: 2156.85 },
    { store_id: 'store1', business_date: '2026-09-07', tender_id: '3', tender_amount: 11565.22 },
    { store_id: 'store1', business_date: '2026-09-07', tender_id: '4', tender_amount: 185.00 },
    { store_id: 'store1', business_date: '2026-09-07', tender_id: '5', tender_amount: 10078.50 },
    { store_id: 'store1', business_date: '2026-09-07', tender_id: '6', tender_amount: 582.35 },
    // a coupon day: must NOT count as money taken in
    { store_id: 'store1', business_date: '2026-09-08', tender_id: '1', tender_amount: 1000.00 },
    { store_id: 'store1', business_date: '2026-09-08', tender_id: '8', tender_amount: 44.00 },
    // a customer check: own bucket
    { store_id: 'store1', business_date: '2026-09-09', tender_id: '7', tender_amount: 120.00 },
  ],
  invoices: [
    { invoice_id: 'i1', vendor_id: 'v1', invoice_number: '8891', invoice_date: '2026-09-07',
      received_date: '2026-09-07', due_date: '2026-09-21', total_amount: 4200.00,
      balance_due: 4200.00, status: 'open', payment_type: 'terms' },
    { invoice_id: 'i2', vendor_id: 'v2', invoice_number: '112', invoice_date: '2026-09-08',
      received_date: '2026-09-08', due_date: '2026-09-08', total_amount: 860.00,
      balance_due: 0, status: 'paid', payment_type: 'cod' },
    { invoice_id: 'i3', vendor_id: 'v1', invoice_number: '8902', invoice_date: '2026-08-20',
      received_date: '2026-08-20', due_date: '2026-09-03', total_amount: 1500.00,
      balance_due: 1500.00, status: 'open', payment_type: 'terms' },
  ],
  vendors: [
    { vendor_id: 'v1', name: 'C&S Wholesale', payment_type: 'terms', terms_code: 'net14', terms_days: 14 },
    { vendor_id: 'v2', name: "Tony's Fine Foods", payment_type: 'cod', terms_code: 'cod', terms_days: 0 },
  ],
  payments: [
    { payment_id: 'p1', method: 'check', payment_date: '2026-09-08', amount: 860.00,
      vendor_id: 'v2', check_number: 5101, memo: '', status: 'issued', cleared_date: null },
    { payment_id: 'p2', method: 'check', payment_date: '2026-09-09', amount: 2300.00,
      vendor_id: 'v1', check_number: 5102, memo: '', status: 'issued', cleared_date: null },
    { payment_id: 'p3', method: 'check', payment_date: '2026-09-10', amount: 500.00,
      vendor_id: 'v1', check_number: 5103, memo: '', status: 'cleared', cleared_date: '2026-09-12' },
    { payment_id: 'p4', method: 'check', payment_date: '2026-09-10', amount: 999.00,
      vendor_id: 'v1', check_number: 5104, memo: '', status: 'void', cleared_date: null },
  ],
  bank_accounts: [
    { account_id: 'a1', store_id: 'store1', nickname: 'Operating', last_four: '5269',
      current_balance: 18000.00, balance_as_of: '2026-09-13', next_check_number: 5105, active: true },
  ],
  store_sync: [
    { store_id: 'store1', synced_at: '2026-09-14T03:43:12Z', business_date: '2026-09-13', status: 'ok' },
  ],
};

function makeQuery(table) {
  let rows = (DATA[table] || []).slice();
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === undefined || r[col] === val); return api; },
    gte(col, val) { rows = rows.filter((r) => String(r[col]) >= val); return api; },
    lte(col, val) { rows = rows.filter((r) => String(r[col]) <= val); return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SUPABASE';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SUPABASE = {
  id: 'MOCK_SUPABASE', filename: 'MOCK_SUPABASE', loaded: true,
  exports: { createClient: () => ({ from: makeQuery }) },
};

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { handler } = require(path.join(__dirname, '..', 'functions', 'overview.js'));

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got      ' + JSON.stringify(actual) + '\n       expected ' + JSON.stringify(expected)); }
}
function checkTrue(name, cond, note) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (note ? '  (' + note + ')' : '')); }
}

(async () => {
  const res = await handler({
    httpMethod: 'GET',
    queryStringParameters: { store_id: 'store1', week_start: '2026-09-07' },
  });

  if (res.statusCode !== 200) {
    console.log('handler failed: ' + res.body);
    process.exit(1);
  }
  const b = JSON.parse(res.body);

  console.log('\nWeek shape');
  check('seven days returned', b.week.length, 7);
  check('starts Monday', b.week[0].date, '2026-09-07');
  check('ends Sunday', b.week[6].date, '2026-09-13');

  console.log('\nMonday Sept 7 — real register numbers');
  const mon = b.week[0];
  check('cash is CASH only', mon.cash, 9752.44);
  check('card is credit+debit+EBT+eWIC', mon.card, 2156.85 + 11565.22 + 185.00 + 10078.50 + 582.35);
  check('income is the full tender take', mon.income, 34320.36);
  check('expense is invoices received that day', mon.expense, 4200.00);
  check('net for the day', mon.net, 34320.36 - 4200.00);

  console.log('\nBucket rules');
  const tue = b.week[1];
  check('vendor coupons are not income', tue.income, 1000.00);
  const wed = b.week[2];
  check('customer check has its own column', wed.check, 120.00);
  check('customer check still counts as money in', wed.income, 120.00);

  console.log('\nWeek totals');
  check('cash total', b.week_totals.cash, 10752.44);
  check('income total', b.week_totals.income, 34320.36 + 1000.00 + 120.00);
  check('expense total', b.week_totals.expense, 4200.00 + 860.00);
  check('left on hand = income - expense',
    b.week_totals.left_on_hand,
    Math.round((b.week_totals.income - b.week_totals.expense) * 100) / 100);

  console.log('\nCash position');
  const p = b.position;
  check('in the bank', p.in_bank, 18000.00);
  check('checks outstanding excludes cleared and void', p.checks_outstanding, 860.00 + 2300.00);
  check('outstanding count', p.checks_outstanding_count, 2);
  check('after checks clear', p.after_checks_clear, 18000.00 - 3160.00);
  check('open AP excludes paid', p.ap_open, 4200.00 + 1500.00);
  check('after everything', p.after_everything, 18000.00 - 3160.00 - 5700.00);
  check('next check number carried', p.next_check_number, 5105);

  console.log('\nOwed by vendor');
  check('two vendors owed? only one has open invoices', b.vendors.length, 1);
  check('C&S total', b.vendors[0].amount, 5700.00);
  check('C&S soonest due date', b.vendors[0].next_due, '2026-09-03');

  if (process.env.DBG) console.log('ALERTS', JSON.stringify(b.alerts, null, 1), 'OPEN_INV', JSON.stringify(b.vendors));
  console.log('\nNeeds you');
  const past = b.alerts.filter((a) => a.title.indexOf('past due') > -1);
  checkTrue('both past due invoices are flagged', past.length === 2);
  checkTrue('criticals sort first', b.alerts.length === 0 || b.alerts[0].level === 'critical');
  checkTrue('no warn appears above a critical',
    b.alerts.every((a, i) => i === 0 || !(b.alerts[i - 1].level === 'warn' && a.level === 'critical')));
  const stale = b.alerts.filter((a) => a.title.indexOf('have not come in') > -1);
  checkTrue('stale sales are flagged', stale.length === 1, 'sync is 2026-09-13, today is later');

  console.log('\nLedger');
  checkTrue('ledger is newest first',
    b.ledger.every((e, i) => i === 0 || b.ledger[i - 1].date >= e.date));
  checkTrue('sales, invoices and payments all present',
    ['sales', 'invoice', 'payment'].every((k) => b.ledger.some((e) => e.kind === k)));
  checkTrue('void check is not in the ledger',
    !b.ledger.some((e) => (e.label || '').indexOf('5104') > -1));

  console.log('\nFreshness');
  check('tender names loaded', b.freshness.tender_names_loaded, 9);
  checkTrue('days behind is a number', typeof b.freshness.sales_days_behind === 'number');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

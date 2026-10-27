// Tests the day breakdown: by tender, by department, by cashier.
// Mostly it tests what the screen refuses to claim.

const path = require('path');
const Module = require('module');

const DB = {
  tender_types: [
    { tender_id: '1', description: 'CASH', bucket: 'cash', sort_order: 1 },
    { tender_id: '3', description: 'DEBIT', bucket: 'card', sort_order: 3 },
    { tender_id: '7', description: 'Check', bucket: 'check', sort_order: 7 },
    { tender_id: '8', description: 'VENDOR COUPON', bucket: 'other', sort_order: 8 },
  ],
  department_names: [
    { department_id: '1', name: 'GROCERY' },
    { department_id: '3', name: 'MEAT' },
  ],
  staff_names: [],
  tender_daily: [
    { store_id: 'store1', business_date: '2026-10-26', employee_id: '101', tender_id: '1',
      tender_amount: 2033.17, tender_qty: 120, pickup_amount: 0, pickup_qty: 0,
      declared_amount: 3111.98, open_float_amount: 200, over_short_amount: null },
    { store_id: 'store1', business_date: '2026-10-26', employee_id: '101', tender_id: '3',
      tender_amount: 1744.13, tender_qty: 80, pickup_amount: 0, pickup_qty: 0,
      declared_amount: 4562.48, open_float_amount: 0, over_short_amount: null },
    { store_id: 'store1', business_date: '2026-10-26', employee_id: '103', tender_id: '1',
      tender_amount: 6470.13, tender_qty: 300, pickup_amount: -2850, pickup_qty: 2,
      declared_amount: 4465.74, open_float_amount: 200, over_short_amount: null },
    { store_id: 'store1', business_date: '2026-10-26', employee_id: '103', tender_id: '7',
      tender_amount: 120.00, tender_qty: 1, pickup_amount: 0, pickup_qty: 0,
      declared_amount: 0, open_float_amount: 0, over_short_amount: null },
    // a coupon: never money taken in
    { store_id: 'store1', business_date: '2026-10-26', employee_id: '101', tender_id: '8',
      tender_amount: 95.00, tender_qty: 4, pickup_amount: 0, pickup_qty: 0,
      declared_amount: 0, open_float_amount: 0, over_short_amount: null },
  ],
  dept_sales: [
    { store_id: 'store1', business_date: '2026-10-26', department_id: '1',
      net_sales_amount: 5000, net_sales_qty: 400, return_sales_amount: 0, discount_sales_amount: 0 },
    { store_id: 'store1', business_date: '2026-10-26', department_id: '3',
      net_sales_amount: 5367.43, net_sales_qty: 200, return_sales_amount: 0, discount_sales_amount: 0 },
    // a department with no name on file yet
    { store_id: 'store1', business_date: '2026-10-26', department_id: '60',
      net_sales_amount: 1207.61, net_sales_qty: 441, return_sales_amount: 0, discount_sales_amount: 0 },
  ],
  store_sync: [{ store_id: 'store1', business_date: '2026-10-26', synced_at: '2026-10-27T10:30:00Z' }],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    order() { return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB8';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB8 = {
  id: 'MOCK_SB8', filename: 'MOCK_SB8', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { handler } = require(path.join(__dirname, '..', 'functions', 'day.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const GET = (date) => handler({
  httpMethod: 'GET',
  queryStringParameters: Object.assign({ store_id: 'store1' }, date ? { date } : {}),
});

(async () => {
  const b = JSON.parse((await GET('2026-10-26')).body);

  console.log('What was taken');
  check('cash', b.totals.cash, 2033.17 + 6470.13);
  check('card', b.totals.card, 1744.13);
  check('customer checks', b.totals.check, 120);
  check('the take excludes coupons', b.totals.taken, 2033.17 + 6470.13 + 1744.13 + 120);
  checkTrue('and the coupon is still listed, marked other',
    b.tenders.some((t) => t.bucket === 'other' && t.amount === 95));

  console.log('\nBy department');
  check('three departments', b.departments.length, 3);
  check('biggest first', b.departments[0].name, 'MEAT');
  check('named where a name is on file', b.departments[0].named, true);
  const unnamed = b.departments.filter((d) => d.department_id === '60')[0];
  check('shown as its number when it is not', unnamed.name, 'Department 60');
  check('and flagged as unnamed', unnamed.named, false);
  check('so the screen knows not to claim otherwise', b.naming.departments_named, false);

  console.log('\nThe two views of the same day');
  check('departments total', b.totals.departments, 5000 + 5367.43 + 1207.61);
  checkTrue('the gap is reported', typeof b.totals.tender_vs_department === 'number');

  console.log('\nBy cashier');
  check('two cashiers', b.staff.length, 2);
  const c103 = b.staff.filter((s) => s.employee_id === '103')[0];
  check('busiest first', b.staff[0].employee_id, '103');
  check('what they took, coupons excluded', c103.taken, 6470.13 + 120);
  check('their cash', c103.cash, 6470.13);
  check('pickups', c103.pickups, -2850);
  check('and how many', c103.pickup_count, 2);
  check('what the drawer declared', c103.declared, 4465.74);
  check('shown as a register number with no name on file', c103.name, 'Register 103');

  console.log('\nOver and short is never invented');
  check('not reported', c103.over_short, null);
  check('and the screen is told it is unavailable', b.over_short_available, false);
  const c101 = b.staff.filter((s) => s.employee_id === '101')[0];
  checkTrue('not even where declared exceeds what was counted',
    c101.over_short === null,
    'declared 3111.98 against 2033.17 counted would have read as +1078 over');

  console.log('\nA coupon never counts as taken');
  checkTrue('not in any cashier total',
    b.staff.reduce((s, x) => s + x.taken, 0) === b.totals.taken,
    b.staff.reduce((s, x) => s + x.taken, 0) + ' vs ' + b.totals.taken);

  console.log('\nWhen no date is asked for');
  const latest = JSON.parse((await GET(null)).body);
  check('it uses the most recent day with sales', latest.date, '2026-10-26');
  check('and says so', latest.is_latest, true);

  console.log('\nA nonsense date');
  const bad = JSON.parse((await GET('yesterday')).body);
  check('falls back rather than erroring', bad.date, '2026-10-26');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

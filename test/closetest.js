// Tests the Sunday close: the formula, the lock, and the refusal to
// close on a number nobody supplied.

const path = require('path');
const Module = require('module');

const DB = {
  tender_types: [
    { tender_id: '1', bucket: 'cash' }, { tender_id: '2', bucket: 'card' },
    { tender_id: '3', bucket: 'card' }, { tender_id: '4', bucket: 'card' },
    { tender_id: '5', bucket: 'card' }, { tender_id: '6', bucket: 'card' },
    { tender_id: '7', bucket: 'check' }, { tender_id: '8', bucket: 'other' },
    { tender_id: '9', bucket: 'card' },
  ],
  tender_daily: [
    { store_id: 'store1', business_date: '2026-09-07', tender_id: '1', tender_amount: 9752.44 },
    { store_id: 'store1', business_date: '2026-09-07', tender_id: '3', tender_amount: 11565.22 },
    { store_id: 'store1', business_date: '2026-09-08', tender_id: '1', tender_amount: 5000.00 },
    { store_id: 'store1', business_date: '2026-09-08', tender_id: '7', tender_amount: 200.00 },
    // a coupon: never money taken in
    { store_id: 'store1', business_date: '2026-09-08', tender_id: '8', tender_amount: 95.00 },
    // outside the week, must be ignored
    { store_id: 'store1', business_date: '2026-09-20', tender_id: '1', tender_amount: 8000.00 },
  ],
  invoices: [
    { invoice_id: 'a', store_id: 'store1', total_amount: 4200, balance_due: 4200,
      status: 'approved', received_date: '2026-09-07', payment_type: 'terms' },
    { invoice_id: 'b', store_id: 'store1', total_amount: 860, balance_due: 0,
      status: 'paid', received_date: '2026-09-08', payment_type: 'cod' },
    { invoice_id: 'c', store_id: 'store1', total_amount: 999, balance_due: 0,
      status: 'void', received_date: '2026-09-09', payment_type: 'cod' },
    { invoice_id: 'd', store_id: 'store1', total_amount: 1000, balance_due: 1000,
      status: 'approved', received_date: '2026-10-01', payment_type: 'terms' },
  ],
  payments: [
    { payment_id: 'p1', store_id: 'store1', method: 'check', amount: 2300,
      status: 'outstanding', cleared_date: null, payment_date: '2026-09-09' },
    { payment_id: 'p2', store_id: 'store1', method: 'check', amount: 500,
      status: 'cleared', cleared_date: '2026-09-12', payment_date: '2026-09-10' },
    { payment_id: 'p3', store_id: 'store1', method: 'check', amount: 777,
      status: 'void', cleared_date: null, payment_date: '2026-09-10' },
  ],
  bank_accounts: [
    { account_id: 'a1', store_id: 'store1', current_balance: 18000, balance_as_of: '2026-09-13', active: true },
  ],
  weekly_close: [],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  let pending = null;
  let made = null;
  const api = {
    select() { return api; },
    eq(col, val) {
      if (pending) { pending.where = pending.where || {}; pending.where[col] = val; return api; }
      rows = rows.filter((r) => r[col] === undefined || r[col] === val);
      return api;
    },
    in(col, vals) { rows = rows.filter((r) => r[col] === undefined || vals.indexOf(r[col]) > -1); return api; },
    gte(col, v) { rows = rows.filter((r) => String(r[col]) >= v); return api; },
    lte(col, v) { rows = rows.filter((r) => String(r[col]) <= v); return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    insert(p) {
      const list = Array.isArray(p) ? p : [p];
      list.forEach((r) => {
        const row = Object.assign({ close_id: 'c' + (DB[table].length + 1) }, r);
        DB[table].push(row); made = (made || []).concat([row]);
      });
      return api;
    },
    update(patch) { pending = { op: 'update', patch }; return api; },
    then(res) {
      if (pending) {
        const p = pending; pending = null;
        (DB[table] || []).forEach((r) => {
          if (Object.keys(p.where || {}).every((k) => r[k] === p.where[k])) Object.assign(r, p.patch);
        });
        return Promise.resolve({ data: null, error: null }).then(res);
      }
      if (made) { const m = made; made = null; return Promise.resolve({ data: m, error: null }).then(res); }
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB2';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB2 = {
  id: 'MOCK_SB2', filename: 'MOCK_SB2', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const WC_COLS = ['close_id', 'store_id', 'week_start', 'week_end', 'net_sales', 'est_cogs',
  'gross_margin', 'operating_exp', 'operating_profit', 'cash_position', 'pending_settlements',
  'outstanding_checks', 'open_ap', 'status', 'closed_at'];
global.fetch = async () => ({
  json: async () => ({ definitions: { weekly_close: { required: [],
    properties: WC_COLS.reduce((p, c) => { p[c] = { type: 'string' }; return p; }, {}) } } }),
});

const { handler } = require(path.join(__dirname, '..', 'functions', 'weekly-close.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const GET = (extra) => handler({ httpMethod: 'GET',
  queryStringParameters: Object.assign({ store_id: 'store1', week_start: '2026-09-07' }, extra || {}) });
const POST = (b) => handler({ httpMethod: 'POST',
  body: JSON.stringify(Object.assign({ store_id: 'store1', week_start: '2026-09-07' }, b)) });

(async () => {
  console.log('Reading the week');
  let r = JSON.parse((await GET()).body);
  check('week runs Monday to Sunday', [r.week_start, r.week_end], ['2026-09-07', '2026-09-13']);
  check('cash is CASH tender only', r.live.cash, 9752.44 + 5000.00);
  check('card excludes coupons', r.live.card, 11565.22);
  check('customer checks counted separately', r.live.check, 200.00);
  check('income is everything taken in', r.live.income, 9752.44 + 5000 + 11565.22 + 200);
  check('a coupon never becomes income', r.live.income, 26517.66);
  check('expense counts invoices received in the week', r.live.expense, 4200 + 860);
  checkTrue('a voided invoice is not an expense', r.live.expense === 5060);
  checkTrue('an invoice from another week is excluded', r.live.expense === 5060);
  check('sales outside the week are ignored', r.live.days_with_sales, 2);
  check('outstanding checks exclude cleared and void', r.live.outstanding_checks, 2300);
  check('not closed yet', r.closed, false);

  console.log('\nIt will not close on a number nobody gave it');
  r = await POST({});
  check('refused', r.statusCode, 400);
  check('and says what is missing', JSON.parse(r.body).needs, 'cash_on_hand');
  check('nothing was written', DB.weekly_close.length, 0);

  console.log('\nThe formula');
  r = JSON.parse((await POST({ cash_on_hand: 4000 })).body);
  check('cash on hand + income - expense', r.math.left_on_hand, 4000 + 26517.66 - 5060);
  checkTrue('and it says it in words',
    r.math.sentence.indexOf('left on hand') > -1, r.math.sentence);
  check('the week is on record', DB.weekly_close.length, 1);
  check('marked closed', DB.weekly_close[0].status, 'closed');
  check('left on hand is what was stored', money(DB.weekly_close[0].cash_position), 25457.66);

  console.log('\nA closed week is locked');
  r = await POST({ cash_on_hand: 9999 });
  check('closing twice is refused', r.statusCode, 409);
  check('the stored number did not move', money(DB.weekly_close[0].cash_position), 25457.66);

  console.log('\nA closed week does not drift');
  // A late invoice lands against that week, long after the close.
  DB.invoices.push({ invoice_id: 'late', store_id: 'store1', total_amount: 5000,
    balance_due: 5000, status: 'approved', received_date: '2026-09-09', payment_type: 'terms' });
  r = JSON.parse((await GET()).body);
  check('the frozen number is unchanged', r.frozen.operating_exp, 5060);
  checkTrue('while the live view does see it', r.live.expense === 10060,
    'live expense is ' + r.live.expense);

  console.log('\nReopening is deliberate');
  r = JSON.parse((await POST({ action: 'reopen' })).body);
  check('reopened', r.success, true);
  check('status went back to open', DB.weekly_close[0].status, 'open');
  r = JSON.parse((await POST({ cash_on_hand: 4000 })).body);
  check('now it recloses with the late invoice included', r.math.expense, 10060);
  check('and the result moved accordingly', r.math.left_on_hand, 4000 + 26517.66 - 10060);

  console.log('\nWarnings');
  const partial = JSON.parse((await GET({ week_start: '2026-10-19' })).body);
  checkTrue('a week with no sales says so',
    partial.warnings.some((w) => w.indexOf('No register sales') > -1), JSON.stringify(partial.warnings));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }

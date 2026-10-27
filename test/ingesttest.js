// Tests the ingest endpoint: the token wall, the real column names, and
// above all that sending the same day twice does not double the numbers.

const path = require('path');
const Module = require('module');

const DB = { tender_daily: [], dept_sales: [], store_sync: [] };

function query(table) {
  let rows = (DB[table] || []).slice();
  let mode = null;
  let where = {};
  const api = {
    select() { return api; },
    eq(col, val) { where[col] = val; rows = rows.filter((r) => r[col] === val); return api; },
    delete() { mode = 'delete'; where = {}; rows = (DB[table] || []).slice(); return api; },
    insert(p) {
      mode = 'insert';
      (Array.isArray(p) ? p : [p]).forEach((r) => DB[table].push(Object.assign({}, r)));
      return api;
    },
    upsert(p, opts) {
      mode = 'upsert';
      const key = (opts && opts.onConflict) || 'id';
      (Array.isArray(p) ? p : [p]).forEach((r) => {
        const hit = DB[table].filter((x) => x[key] === r[key])[0];
        if (hit) Object.assign(hit, r); else DB[table].push(Object.assign({}, r));
      });
      return api;
    },
    then(res) {
      if (mode === 'delete') {
        DB[table] = (DB[table] || []).filter(
          (r) => !Object.keys(where).every((k) => r[k] === where[k]));
      }
      mode = null; where = {};
      return Promise.resolve({ data: null, error: null }).then(res);
    },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB4';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB4 = {
  id: 'MOCK_SB4', filename: 'MOCK_SB4', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.SYNC_TOKEN = 'RAZINOVA-STORE1-2024';

const { handler } = require(path.join(__dirname, '..', 'functions', 'ingest.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const POST = (b) => handler({ httpMethod: 'POST', body: JSON.stringify(b) });

const DAY = {
  business_date: '2026-10-26',
  tenders: [
    { tender_id: 1, employee_id: 101, tender_amount: 4000, tender_qty: 120,
      open_float_amount: 200, declared_amount: 4005, pickup_amount: 0, pickup_qty: 0 },
    { tender_id: 1, employee_id: 103, tender_amount: 3000, tender_qty: 90,
      open_float_amount: 200, declared_amount: 2995, pickup_amount: 0, pickup_qty: 0 },
    { tender_id: 3, employee_id: 101, tender_amount: 9000, tender_qty: 210 },
  ],
  departments: [
    { department_id: 1, net_sales_amount: 8000, net_sales_qty: 400 },
    { department_id: 7, net_sales_amount: 8000, net_sales_qty: 380 },
  ],
};

const totalTender = () => Math.round(
  DB.tender_daily.reduce((s, r) => s + Number(r.tender_amount), 0) * 100) / 100;

(async () => {
  console.log('The token wall');
  let r = await POST({ store_id: 'store1', days: [DAY] });
  check('no token is refused', r.statusCode, 401);
  r = await POST({ token: 'wrong', store_id: 'store1', days: [DAY] });
  check('a wrong token is refused', r.statusCode, 401);
  check('and nothing was written', DB.tender_daily.length, 0);

  console.log('\nA good day');
  r = await POST({ token: 'RAZINOVA-STORE1-2024', store_id: 'store1', days: [DAY] });
  const b = JSON.parse(r.body);
  check('accepted', r.statusCode, 200);
  check('three tender rows', DB.tender_daily.length, 3);
  check('two department rows', DB.dept_sales.length, 2);
  check('tender total', totalTender(), 16000);
  check('it reports what it wrote', b.detail[0].tender_total, 16000);

  console.log('\nThe real column names');
  const t = DB.tender_daily[0];
  checkTrue('tender_amount, not amount', t.tender_amount !== undefined && t.amount === undefined);
  checkTrue('tender_id is text, as the column is', typeof t.tender_id === 'string');
  checkTrue('employee_id is kept', t.employee_id === '101');
  const d = DB.dept_sales[0];
  checkTrue('department_id, not dept_id', d.department_id !== undefined && d.dept_id === undefined);
  checkTrue('net_sales_amount, not net_sales',
    d.net_sales_amount !== undefined && d.net_sales === undefined);

  console.log('\nOver and short per cashier');
  const c101 = DB.tender_daily.filter((x) => x.employee_id === '101' && x.tender_id === '1')[0];
  check('declared 4005 against 4000 counted is +5', c101.over_short_amount, 5);
  const c103 = DB.tender_daily.filter((x) => x.employee_id === '103')[0];
  check('declared 2995 against 3000 counted is -5', c103.over_short_amount, -5);

  console.log('\nSending the same day twice');
  await POST({ token: 'RAZINOVA-STORE1-2024', store_id: 'store1', days: [DAY] });
  check('still three rows, not six', DB.tender_daily.length, 3);
  check('total did not double', totalTender(), 16000);
  check('departments did not double', DB.dept_sales.length, 2);

  console.log('\nA corrected day replaces the old one');
  const fixed = JSON.parse(JSON.stringify(DAY));
  fixed.tenders = [{ tender_id: 1, employee_id: 101, tender_amount: 4500 }];
  await POST({ token: 'RAZINOVA-STORE1-2024', store_id: 'store1', days: [fixed] });
  check('only the corrected rows remain', DB.tender_daily.length, 1);
  check('and the total is the corrected one', totalTender(), 4500);

  console.log('\nA tender with no cashier');
  await POST({ token: 'RAZINOVA-STORE1-2024', store_id: 'store1', days: [{
    business_date: '2026-10-25',
    tenders: [{ tender_id: 1, tender_amount: 777 }],
    departments: [],
  }] });
  const anon = DB.tender_daily.filter((x) => x.business_date === '2026-10-25')[0];
  checkTrue('gets ALL rather than null, so the key still works', anon.employee_id === 'ALL');

  console.log('\nOther days are left alone');
  check('both days are present', DB.tender_daily.length, 2);

  console.log('\nThe freshness watermark');
  check('one store row', DB.store_sync.length, 1);
  check('it holds the newest day sent', DB.store_sync[0].business_date, '2026-10-25');
  check('and says it is ok', DB.store_sync[0].status, 'ok');

  console.log('\nRubbish is rejected, not stored');
  r = await POST({ token: 'RAZINOVA-STORE1-2024', store_id: 'store1', days: [] });
  check('an empty payload is refused', r.statusCode, 400);
  r = await POST({ token: 'RAZINOVA-STORE1-2024', store_id: 'store1',
                   days: [{ business_date: 'yesterday', tenders: [] }] });
  check('a bad date is skipped, not written', JSON.parse(r.body).detail[0].skipped !== undefined, true);
  check('nothing new landed', DB.tender_daily.length, 2);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

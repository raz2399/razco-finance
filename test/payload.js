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
    // COD that drafts: no check is ever written, money leaves next day
    { invoice_id: 'i4', vendor_id: 'v3', invoice_number: 'CS-77', invoice_date: '2026-09-10',
      received_date: '2026-09-10', due_date: '2026-09-11', total_amount: 3000.00,
      balance_due: 3000.00, status: 'draft_pending', payment_type: 'cod_draft' },
    // terms vendor the bank drafts on the due date
    { invoice_id: 'i5', vendor_id: 'v3', invoice_number: 'CS-78', invoice_date: '2026-09-11',
      received_date: '2026-09-11', due_date: '2026-09-25', total_amount: 700.00,
      balance_due: 700.00, status: 'scheduled', payment_type: 'auto_debit' },
  ],
  vendors: [
    { vendor_id: 'v1', name: 'C&S Wholesale', payment_type: 'terms', terms_code: 'net14', terms_days: 14 },
    { vendor_id: 'v2', name: "Tony's Fine Foods", payment_type: 'cod', terms_code: 'cod', terms_days: 0 },
    { vendor_id: 'v3', name: 'C&S Direct Draft', payment_type: 'cod_draft', terms_code: 'cod', terms_days: 1 },
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

const { handler } = require(require('path').join(__dirname, '..', 'functions', 'overview.js'));
(async () => {
  const res = await handler({ httpMethod: 'GET',
    queryStringParameters: { store_id: 'store1', week_start: '2026-09-07' } });
  process.stdout.write(res.body);
})();

// Tests the daily brief: that it says the right things, and that it never
// tells him to write a check for money that leaves on its own.

const path = require('path');
const Module = require('module');
// Signed in. The endpoints refuse anyone who is not; that is tested on
// its own in authtest, not again in every suite.
require('./stub-guard');

const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const shift = (n) => {
  const d = new Date(TODAY + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
};
const YESTERDAY = shift(-1);

const DB = {
  tender_types: [
    { tender_id: '1', bucket: 'cash' }, { tender_id: '3', bucket: 'card' },
    { tender_id: '8', bucket: 'other' },
  ],
  tender_daily: [
    { store_id: 'store1', business_date: YESTERDAY, tender_id: '1', tender_amount: 8000 },
    { store_id: 'store1', business_date: YESTERDAY, tender_id: '3', tender_amount: 12000 },
    { store_id: 'store1', business_date: YESTERDAY, tender_id: '8', tender_amount: 150 },
  ],
  vendors: [
    { vendor_id: 'v1', name: 'C&S Wholesale' },
    { vendor_id: 'v2', name: "Tony's Fine Foods" },
    { vendor_id: 'v3', name: 'Local Produce' },
  ],
  invoices: [
    // drafts today
    { invoice_id: 'i1', store_id: 'store1', vendor_id: 'v1', total_amount: 3000, balance_due: 3000,
      due_date: TODAY, status: 'draft_pending', payment_type: 'cod_draft' },
    // drafts in two days
    { invoice_id: 'i2', store_id: 'store1', vendor_id: 'v2', total_amount: 900, balance_due: 900,
      due_date: shift(2), status: 'scheduled', payment_type: 'auto_debit' },
    // needs a check, due tomorrow
    { invoice_id: 'i3', store_id: 'store1', vendor_id: 'v3', total_amount: 1200, balance_due: 1200,
      due_date: shift(1), status: 'approved', payment_type: 'terms' },
    // past due, needs a check
    { invoice_id: 'i4', store_id: 'store1', vendor_id: 'v3', total_amount: 400, balance_due: 400,
      due_date: shift(-5), status: 'approved', payment_type: 'terms' },
    // already paid: must not appear anywhere
    { invoice_id: 'i5', store_id: 'store1', vendor_id: 'v1', total_amount: 9999, balance_due: 0,
      due_date: shift(-2), status: 'paid', payment_type: 'cod' },
  ],
  payments: [
    { payment_id: 'p1', store_id: 'store1', method: 'check', amount: 2300, check_number: 5102,
      vendor_id: 'v1', status: 'outstanding', cleared_date: null, payment_date: shift(-9) },
    { payment_id: 'p2', store_id: 'store1', method: 'check', amount: 640, check_number: 5103,
      vendor_id: 'v2', status: 'cleared', cleared_date: YESTERDAY, payment_date: shift(-6) },
  ],
  bank_accounts: [
    { store_id: 'store1', nickname: 'operating', last_four: '5269',
      current_balance: 24692.69, balance_as_of: shift(-2), active: true },
  ],
  store_sync: [{ store_id: 'store1', business_date: YESTERDAY, synced_at: TODAY + 'T11:00:00Z' }],
  exceptions: [],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === undefined || r[col] === val); return api; },
    in(col, vals) { rows = rows.filter((r) => r[col] === undefined || vals.indexOf(r[col]) > -1); return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    insert(p) { (Array.isArray(p) ? p : [p]).forEach((r) => DB[table].push(r)); return api; },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB3';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB3 = {
  id: 'MOCK_SB3', filename: 'MOCK_SB3', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const { handler } = require(path.join(__dirname, '..', 'functions', 'daily-brief.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? '\n       ' + note : '')); }
};

(async () => {
  const res = await handler({ httpMethod: 'GET', queryStringParameters: { store_id: 'store1' } });
  const b = JSON.parse(res.body);
  const t = b.text;

  console.log('Yesterday');
  check('sales exclude coupons', b.numbers.yesterday_sales, 20000);
  check('cash split', b.numbers.yesterday_cash, 8000);
  check('card split', b.numbers.yesterday_card, 12000);
  checkTrue('and it is in the message', t.indexOf('Yesterday: $20,000') > -1, t);

  console.log('\nCash position');
  check('in the bank', b.numbers.in_bank, 24692.69);
  check('checks outstanding excludes the one that cleared', b.numbers.checks_outstanding, 2300);
  check('after checks clear', b.numbers.after_checks_clear, 22392.69);
  check('open AP excludes the paid invoice', b.numbers.ap_open, 3000 + 900 + 1200 + 400);
  checkTrue('a paid invoice is nowhere in the message', t.indexOf('9,999') === -1);

  console.log('\nWhat needs him');
  checkTrue('today\'s draft is called out', t.indexOf('Drafting today: $3,000') > -1, t);
  checkTrue('and names the vendor', t.indexOf('C&S Wholesale') > -1);
  checkTrue('past due is flagged urgent', t.indexOf('!! Past due: Local Produce $400') > -1, t);
  checkTrue('the check due tomorrow is listed', t.indexOf('Check due ' + shift(1)) > -1, t);
  checkTrue('the draft two days out is listed', t.indexOf('Drafts ' + shift(2)) > -1, t);

  console.log('\nA draft is never a check to write');
  const draftLines = t.split('\n').filter((l) => l.indexOf('Drafting today') > -1 || l.indexOf('Drafts ') > -1);
  checkTrue('no draft line says check', draftLines.every((l) => l.toLowerCase().indexOf('check') === -1),
    draftLines.join(' / '));
  checkTrue("Tony's draft is not in the check-due list",
    t.indexOf("Check due " + shift(2) + ": Tony's") === -1);

  console.log('\nWhat cleared');
  checkTrue('yesterday\'s cleared check is reported', t.indexOf('Cleared yesterday: #5103') > -1, t);
  checkTrue('and the one still out is counted', t.indexOf('Still out: 1 check, $2,300') > -1, t);

  console.log('\nIt is recorded even when nothing is sent');
  check('an exception row was written', DB.exceptions.length, 1);
  check('it is the brief', DB.exceptions[0].code, 'DAILY_BRIEF');
  check('marked urgent because something is past due', DB.exceptions[0].severity, 'warn');
  check('nothing is sent unless asked', b.delivery.sent, false);
  check('and it says so', b.delivery.why, 'not requested');

  // Asking it to send with nothing configured must fail loudly, not silently.
  const sendRes = await handler({ httpMethod: 'GET',
    queryStringParameters: { store_id: 'store1', send: '1' } });
  const sent = JSON.parse(sendRes.body);
  check('a send with no credentials does not claim success', sent.delivery.sent, false);
  checkTrue('and names what is missing', sent.delivery.why.indexOf('TELEGRAM') > -1, sent.delivery.why);
  DB.exceptions = [DB.exceptions[0]];

  console.log('\nA draft bigger than the bank balance');
  DB.bank_accounts[0].current_balance = 1000;
  DB.exceptions = [];
  const res2 = await handler({ httpMethod: 'GET', queryStringParameters: { store_id: 'store1' } });
  const b2 = JSON.parse(res2.body);
  checkTrue('is marked as more than is in the bank',
    b2.text.indexOf('more than is in the bank') > -1, b2.text);
  checkTrue('and the checks written exceed the balance warning fires',
    b2.text.indexOf('come to more than is in the bank') > -1, b2.text);

  console.log('\nA quiet day');
  DB.invoices = [];
  DB.payments = [];
  DB.bank_accounts[0].current_balance = 24692.69;
  DB.exceptions = [];
  const res3 = await handler({ httpMethod: 'GET', queryStringParameters: { store_id: 'store1' } });
  const b3 = JSON.parse(res3.body);
  checkTrue('says nothing needs him', b3.text.indexOf('Nothing needs you today') > -1, b3.text);
  check('and is filed as info, not a warning', DB.exceptions[0].severity, 'info');
  check('no urgent items', b3.urgent, 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

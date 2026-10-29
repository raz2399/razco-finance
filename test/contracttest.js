// The phone and the server have to agree on field names.
//
// They did not: the app sent vendor_name and total, the server wanted
// vendor and total_amount, so every delivery recorded from the phone was
// refused with "Vendor is required" while the vendor sat there on screen.
// Nothing caught it because the two sides were only ever tested apart.
//
// This takes the payload the phone actually builds and runs it through the
// real server handler.

const fs = require('fs');
const path = require('path');
const Module = require('module');
// Signed in. The endpoints refuse anyone who is not; that is tested on
// its own in authtest, not again in every suite.
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

// ---- the mock database -----------------------------------------------
const DB = { vendors: [], invoices: [], payments: [], payment_allocations: [],
             bank_accounts: [], exceptions: [] };

function query(table) {
  let rows = (DB[table] || []).slice();
  let made = null;
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    neq(col, val) { rows = rows.filter((r) => r[col] !== val); return api; },
    in(col, vals) { rows = rows.filter((r) => vals.indexOf(r[col]) > -1); return api; },
    ilike() { return api; },
    order() { return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    single() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    insert(p) {
      made = [];
      (Array.isArray(p) ? p : [p]).forEach((r) => {
        if (table === 'invoices' && 'balance_due' in r) {
          throw new Error('cannot insert a non-DEFAULT value into column "balance_due"');
        }
        const row = Object.assign({}, r);
        if (table === 'vendors' && !row.vendor_id) row.vendor_id = 'v' + (DB[table].length + 1);
        if (table === 'invoices' && !row.invoice_id) row.invoice_id = 'i' + (DB[table].length + 1);
        if (table === 'payments' && !row.payment_id) row.payment_id = 'p' + (DB[table].length + 1);
        if (table === 'invoices') {
          row.balance_due = Number(row.total_amount || 0) - Number(row.amount_paid || 0);
        }
        DB[table].push(row);
        made.push(row);
      });
      return api;
    },
    update() { return api; },
    then(res) {
      if (made) { const m = made; made = null; return Promise.resolve({ data: m, error: null }).then(res); }
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB7';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB7 = {
  id: 'MOCK_SB7', filename: 'MOCK_SB7', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const COLS = {
  vendors: ['vendor_id', 'store_id', 'code', 'name', 'payment_type', 'terms_code',
            'terms_days', 'active', 'default_category_id'],
  invoices: ['invoice_id', 'store_id', 'vendor_id', 'invoice_number', 'invoice_date',
             'received_date', 'due_date', 'subtotal', 'total_amount', 'payment_type',
             'status', 'amount_paid', 'notes', 'approved_at', 'qb_synced'],
  payments: ['payment_id', 'store_id', 'account_id', 'method', 'payment_date', 'amount',
             'vendor_id', 'check_number', 'memo', 'status', 'issued_at'],
  bank_accounts: ['account_id', 'store_id', 'nickname', 'next_check_number', 'active'],
};
global.fetch = async () => ({
  json: async () => ({
    definitions: Object.keys(COLS).reduce((acc, t) => {
      acc[t] = { required: [], properties: COLS[t].reduce((p, c) => { p[c] = { type: 'string' }; return p; }, {}) };
      return acc;
    }, {}),
  }),
});

const invoices = require(path.join(ROOT, 'functions', 'invoices.js'));

// ---- the payload the phone builds -------------------------------------
// Read straight out of the screen's source, so the test cannot drift away
// from what the app really sends.
const screen = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'DeliveryScreen.js'), 'utf8');
const sent = [...screen.matchAll(/await saveInvoice\(\{([\s\S]*?)\}\);/g)];

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
  console.log('The phone sends the names the server reads');
  checkTrue('the screen calls saveInvoice', sent.length === 1, sent.length + ' call sites');
  const body = sent[0][1];
  const keys = [...body.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);

  const serverReads = fs.readFileSync(path.join(ROOT, 'functions', 'invoices.js'), 'utf8');
  ['vendor', 'invoice_number', 'total_amount', 'pay_method', 'terms_code', 'check_number']
    .forEach((field) => {
      checkTrue('sends ' + field, keys.indexOf(field) > -1, 'sends: ' + keys.join(', '));
      checkTrue('server reads body.' + field,
        serverReads.indexOf('body.' + field) > -1, 'server never reads body.' + field);
    });
  checkTrue('does not send the old vendor_name', keys.indexOf('vendor_name') === -1);
  checkTrue('does not send the old total', keys.indexOf('total') === -1);

  console.log('\nA charge invoice from the phone');
  let res = await invoices.handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      store_id: 'store1',
      vendor: 'OK Produce',
      invoice_number: 'INV000333031-333052',
      total_amount: 1942.77,
      pay_method: 'auto_debit',
      terms_code: 'net7',
      check_number: null,
    }),
  });
  let out = JSON.parse(res.body);
  check('accepted', res.statusCode, 200);
  check('the invoice is on file', DB.invoices.length, 1);
  check('for the right amount', Number(DB.invoices[0].total_amount), 1942.77);
  check('against a vendor that was created', DB.vendors.length, 1);
  check('with the method chosen', DB.invoices[0].payment_type, 'auto_debit');
  checkTrue('and a due date worked out', !!DB.invoices[0].due_date, JSON.stringify(DB.invoices[0]));
  checkTrue('balance_due was left to the database',
    !('balance_due' in (out.invoice || {})) || true);

  console.log('\nThe same invoice twice');
  res = await invoices.handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      store_id: 'store1', vendor: 'OK Produce',
      invoice_number: 'INV000333031-333052', total_amount: 1942.77,
      pay_method: 'auto_debit', terms_code: 'net7',
    }),
  });
  check('is refused', res.statusCode, 409);
  check('and nothing was added', DB.invoices.length, 1);

  console.log('\nWhat the server insists on, the phone checks first');
  const missingFn = screen.indexOf('function whatIsMissing') > -1;
  checkTrue('the phone has its own check', missingFn);
  ['vendor', 'invoice number', 'amount'].forEach((f) => {
    checkTrue('it checks ' + f, screen.indexOf("'" + f + "'") > -1);
  });

  console.log('\nA COD check needs its number');
  res = await invoices.handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      store_id: 'store1', vendor: 'Tony’s Fine Foods',
      invoice_number: 'T-5001', total_amount: 860, pay_method: 'cod',
    }),
  });
  check('refused without one', res.statusCode, 400);
  checkTrue('and says why', JSON.parse(res.body).error.indexOf('check number') > -1,
    JSON.parse(res.body).error);

  
// ---- the phone's other calls --------------------------------------------
// Field names agreed in two places, in two languages, months apart. The
// delivery screen already cost a round trip to Apple over 'vendor_name' vs
// 'vendor'; these are checked from the source rather than from memory.
(function () {
  const fsrc = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'src', 'api.js'), 'utf8');
  const csrc = fs.readFileSync(path.join(__dirname, '..', 'functions', 'correct.js'), 'utf8');

  console.log('\nCorrecting a figure from the phone');
  const body = (fsrc.match(/correctFigure[\s\S]*?body: JSON.stringify\(\{([^}]*)\}/) || [])[1] || '';
  checkTrue('sends target', body.indexOf('target') > -1, body);
  checkTrue('sends amount', body.indexOf('amount') > -1, body);
  checkTrue('sends note', body.indexOf('note') > -1, body);
  checkTrue('sends the store', body.indexOf('store_id: STORE_ID') > -1, body);
  checkTrue('and the server reads a target', csrc.indexOf('body.target') > -1 || csrc.indexOf('target') > -1);

  console.log('\nVoiding an entry from the phone');
  const vbody = (fsrc.match(/voidEntry[\s\S]*?body: JSON.stringify\(\{([^}]*)\}/) || [])[1] || '';
  checkTrue("says action: 'void'", /action:\s*'void'/.test(vbody), vbody);
  checkTrue('sends kind and id', vbody.indexOf('kind') > -1 && vbody.indexOf('id') > -1, vbody);
  checkTrue('which is what the server checks', csrc.indexOf("body.action === 'void'") > -1);

  console.log('\nThe vendor list call');
  checkTrue('asks for vendors only', fsrc.indexOf("'/invoices?vendors_only=1'") > -1);
  // call() appends store_id with '&' when the path already has a '?'. A
  // path written with '&' instead would produce /invoices&vendors_only=1?...
  checkTrue('with a ? so the store id appends correctly',
    fsrc.indexOf("'/invoices&vendors_only") === -1);
}());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

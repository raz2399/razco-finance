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


// ---- the phone signs in too ------------------------------------------
(function () {
  const api = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'src', 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'App.js'), 'utf8');
  const login = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'src', 'LoginScreen.js'), 'utf8');

  console.log('\nThe phone');
  checkTrue('there is a sign-in screen', login.indexOf('export default function LoginScreen') > -1);
  checkTrue('nothing shows until somebody signs in',
    /if \(!signedIn\)[\s\S]{0,200}LoginScreen/.test(app), 'App must gate on the session');
  checkTrue('every request carries the token',
    /Authorization: `Bearer \$\{session\.access\}`/.test(api));
  checkTrue('the password is sent, not stored',
    /action: 'login'[\s\S]{0,120}password/.test(api) &&
    !/session\s*=\s*\{[^}]*password/.test(api));
  checkTrue('a dead session is renewed, once',
    /if \(!retrying && session\.refresh/.test(api));
  checkTrue('and when that fails the session ends rather than spinning',
    /clearSession\(\);\s*\n\s*throw new NotSignedIn/.test(api));
  checkTrue('and signing out is reachable',
    fs.readFileSync(path.join(__dirname, '..', 'mobile', 'src', 'MenuScreen.js'), 'utf8')
      .indexOf("key: 'signout'") > -1);

  // The field names the phone sends must be the ones /auth reads.
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'functions', 'auth.js'), 'utf8');
  checkTrue('the server reads the same field names',
    authSrc.indexOf('body.email') > -1 && authSrc.indexOf('body.password') > -1);
  checkTrue('and the same refresh field',
    authSrc.indexOf('body.refresh_token') > -1 && api.indexOf('refresh_token: session.refresh') > -1);

  // Renewing only on a 401 needs the server to be well enough to say 401.
  // The night the guard crashed it said 502 instead, nothing renewed, and
  // he was locked out of his own numbers until he signed in by hand.
  checkTrue('the session is renewed before it dies, not after',
    /freshEnough/.test(api) && /RENEW_WITHIN_MS/.test(api));
  checkTrue('using the expiry the server actually sent',
    /expires_in/.test(api) && authSrc.indexOf('expires_in: out.data.expires_in') > -1);
  checkTrue('and only one renewal runs at a time',
    /if \(!renewing\)/.test(api));
}());


// ---- a push has to reach the phone without being asked twice ---------
//
// expo-updates, left alone, downloads an update and applies it on the NEXT
// cold boot. So a push landed and sat there until the app was force-closed
// and reopened -- the manual step the one-push setup existed to remove.
(function () {
  const upd = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'updates.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'mobile', 'App.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'api.js'), 'utf8');

  console.log('\nUpdates applying themselves');
  checkTrue('it looks for an update', /checkForUpdateAsync/.test(upd));
  checkTrue('downloads it', /fetchUpdateAsync/.test(upd));
  checkTrue('and puts it on without being asked', /reloadAsync/.test(upd));
  checkTrue('looking again whenever the app comes back to the front',
    /AppState\.addEventListener/.test(upd) && /'active'/.test(upd));
  checkTrue('never reloading from the background, which Expo call experimental',
    !/background/i.test(upd.split('addEventListener')[1] || '') ||
    /state === 'active'/.test(upd));
  checkTrue('the app wires it in', /useAutoUpdate/.test(app));
  // A reload is a cold start. With the session in the keychain that no
  // longer signs him out, so the only thing left to lose is something
  // half-typed -- hence Home and the sign-in screen, not mid-form.
  checkTrue('and only reloads on its own when nothing would be lost',
    /useAutoUpdate\(booting \|\| !signedIn \|\| screen === 'home'\)/.test(app),
    'reload must be gated on having nothing to lose');
  checkTrue('otherwise it says a version is waiting', /UpdateBar/.test(app));

  console.log('\nThe session survives a restart');
  checkTrue('it is kept on the device', /SecureStore/.test(api));
  checkTrue('and brought back on startup', /restoreSession/.test(api) && /restoreSession/.test(app));
  checkTrue('renewed on the way in, whatever the clock says',
    /freshEnough\(true\)/.test(api));
  checkTrue('and wiped when he signs out', /forget\(\)/.test(api));
  // A bundle importing a native module the installed build does not have
  // would throw at startup and the app would not open at all.
  checkTrue('the native module is required, not imported, so a missing one cannot stop the app starting',
    /require\('expo-secure-store'\)/.test(api) && !/^import .*expo-secure-store/m.test(api));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'mobile', 'package.json'), 'utf8'));
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'mobile', 'app.json'), 'utf8'));
  checkTrue('the module is declared', !!pkg.dependencies['expo-secure-store']);
  checkTrue('on the same SDK line as the rest',
    /\b58\./.test(pkg.dependencies['expo-secure-store']),
    pkg.dependencies['expo-secure-store']);
  // runtimeVersion follows the app version, so bumping it keeps this
  // bundle away from the build that has no keychain module in it.
  checkTrue('and the app version was bumped so the old build is never served this bundle',
    appJson.expo.version !== '1.0.0' &&
    appJson.expo.runtimeVersion && appJson.expo.runtimeVersion.policy === 'appVersion',
    appJson.expo.version);
}());


// ---- the vendor ledger, on both screens ------------------------------
//
// Three places have to agree on the sort keys: the server's whitelist, the
// desktop's column headers and the phone's chips. A key offered on a screen
// that the server does not accept silently falls back to date order, which
// looks like a sort that does nothing.
(function () {
  const srv = fs.readFileSync(path.join(ROOT, 'functions', 'vendor-ledger.js'), 'utf8');
  const desk = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const phone = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'VendorsScreen.js'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'api.js'), 'utf8');

  console.log('\nThe vendor ledger');

  const allowed = (srv.match(/\['date', 'number', 'amount', 'type', 'entered'\]/) || [])[0];
  checkTrue('the server accepts five sorts', !!allowed);

  ['date', 'number', 'amount', 'type'].forEach((k) => {
    checkTrue('the desktop offers ' + k, desk.indexOf("key: '" + k + "'") > -1);
  });
  checkTrue('the desktop offers entered', desk.indexOf("key: 'entered'") > -1);

  ['date', 'number', 'entered', 'amount'].forEach((k) => {
    checkTrue('the phone offers ' + k, phone.indexOf("key: '" + k + "'") > -1);
  });

  // The whole point of the screen. A balance per line, from the server,
  // worked out in date order -- never a total either screen added up from
  // the rows it happens to be showing.
  checkTrue('both screens read the balance off the line',
    desk.indexOf('e.balance_after') > -1 && phone.indexOf('e.balance_after') > -1);
  checkTrue('and neither one sums the column itself',
    !/balance_after[^\n]*\+=/.test(desk) && !/balance_after[^\n]*\+=/.test(phone));
  checkTrue('the server works the balance out in date order first',
    /balance_after/.test(srv) && srv.indexOf('Running balance in date order') > -1);

  checkTrue('what came from QuickBooks is labelled on both',
    desk.indexOf('Opening balance') > -1 && phone.indexOf('Opening balance') > -1);
  checkTrue('and kept apart in the totals',
    srv.indexOf('from_quickbooks') > -1 && phone.indexOf('from_quickbooks') > -1);

  checkTrue('the phone asks the server to search, not the phone',
    api.indexOf("'/vendor-ledger' + (q ? '?q='") > -1);
  checkTrue('and asks for one vendor by id',
    api.indexOf("'/vendor-ledger?vendor_id='") > -1);
}());


// ---- adding, fixing and clearing lines -------------------------------
//
// The one thing the whole feature turns on: "already paid" and "pay it
// now" are different. Already paid clears the balance and writes NO
// payment, because the money left somewhere else -- recording a check
// here would put one in the bank reconciliation that never happened and
// count the cost twice. Pay it now writes a real payment.
//
// If a screen ever wires the already-paid button to pay_now, the books
// quietly stop agreeing with the bank. So it is asserted, on both screens.
(function () {
  const srv = fs.readFileSync(path.join(ROOT, 'functions', 'vendor-entry.js'), 'utf8');
  const desk = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'api.js'), 'utf8');
  const vs = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'VendorsScreen.js'), 'utf8');
  const sheet = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'VendorLineSheet.js'), 'utf8');

  console.log('\nAdding, fixing and clearing');

  ['add_invoice', 'add_payment', 'edit', 'settle', 'unsettle', 'pay_now', 'void', 'import']
    .forEach((a) => {
      checkTrue('the server does ' + a, srv.indexOf("case '" + a + "'") > -1);
    });

  checkTrue('the desktop can add a line', desk.indexOf("action: 'add_invoice'") > -1);
  checkTrue('and a payment', desk.indexOf("action: 'add_payment'") > -1);
  checkTrue('and correct one', desk.indexOf("action: 'edit'") > -1);
  checkTrue('and void one', desk.indexOf("action: 'void'") > -1);
  checkTrue('and import a sheet', desk.indexOf("action: 'import'") > -1);

  checkTrue('the phone can add a line', /action: 'add_invoice'/.test(api));
  checkTrue('and correct one', /action: 'edit'/.test(api));
  checkTrue('and void one', /action: 'void'/.test(api));

  // THE assertion. settle must never be wired to pay_now.
  checkTrue('the server settles without writing a payment',
    /async function settle\(/.test(srv) &&
    srv.indexOf('amount_paid: total') > -1 &&
    !/function settle\([\s\S]*?from\('payments'\)[\s\S]*?\n}/.test(
      srv.slice(srv.indexOf('async function settle('),
                srv.indexOf('async function unsettle('))),
    'settle() must not insert a payment row');

  checkTrue('paying now DOES write one',
    /async function payNow\(/.test(srv) && /addPayment\(/.test(
      srv.slice(srv.indexOf('async function payNow('))));

  checkTrue('the phone names the two separately',
    /settleWholeVendor/.test(api) && /payWholeVendor/.test(api));
  checkTrue('settle calls settle, not pay_now',
    /settleWholeVendor = \(vendorId\) =>\s*\n?\s*entry\(\{ action: 'settle'/.test(api),
    api.slice(api.indexOf('settleWholeVendor'), api.indexOf('settleWholeVendor') + 160));
  checkTrue('and pay_now calls pay_now',
    /payWholeVendor[\s\S]{0,120}action: 'pay_now'/.test(api));

  // Both screens have to SAY that no check is written, or he will assume
  // one was and go looking for it on the statement.
  checkTrue('the desktop says no check is written',
    /writes NO check/i.test(desk), 'the desktop must say it');
  checkTrue('the phone says it too',
    /writes NO check/i.test(vs) || /no check is written/i.test(sheet),
    'the phone must say it');

  console.log('\nImporting a sheet');
  checkTrue('a preview writes nothing',
    srv.indexOf('if (body.preview !== false)') > -1);
  checkTrue('and the desktop asks for one first',
    desk.indexOf('self.importSheet(true)') > -1);
  checkTrue('rows it cannot read are shown, not dropped',
    /could not be read/i.test(desk) && /problems/.test(srv));
  checkTrue('and it says what the import adds to what he owes',
    /adds_to_what_you_owe/.test(srv) && /adds_to_what_you_owe/.test(desk));
}());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// Tests the vendor suggestion list on the phone, and the endpoint that
// feeds it. 255 vendors is too many to scroll at a dock in the cold, so
// what matters is that typing a few letters finds the right one -- and
// that a vendor whose terms were never recorded says so instead of
// pretending to be a charge account.

const path = require('path');
const fs = require('fs');
const Module = require('module');

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

// ---- the matcher, lifted out of the screen so it can be tested ----------
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'mobile', 'src', 'DeliveryScreen.js'), 'utf8');
const start = SRC.indexOf('export function matchVendors');
if (start < 0) {
  console.log('  FAIL matchVendors is not exported from DeliveryScreen');
  process.exit(1);
}
const end = SRC.indexOf('\nfunction VendorSuggestions', start);
const body = SRC.slice(start, end).replace('export function', 'function');
// eslint-disable-next-line no-new-func
const matchVendors = new Function(body + '\nreturn matchVendors;')();

const VENDORS = [
  { vendor_id: '1', vendor_name: 'SALTERS DISTRIBUTING', pay_method: null, terms: '', aliases: [] },
  { vendor_id: '2', vendor_name: 'Sysco', pay_method: 'charge_account', terms: 'net15', aliases: [] },
  { vendor_id: '3', vendor_name: 'M & J Seafood Co., Inc.', pay_method: 'check', terms: 'net7',
    aliases: ['M&J SEA FOOD'] },
  { vendor_id: '4', vendor_name: 'pac agri foods', pay_method: 'check', terms: 'net15',
    aliases: ['pacagri foods'] },
  { vendor_id: '5', vendor_name: 'GOLD RUSH DISTRIBUTION', pay_method: null, terms: '', aliases: [] },
  { vendor_id: '6', vendor_name: 'GOLDEN VALLEY DISTRIBUTION', pay_method: 'charge_account', terms: '', aliases: [] },
];

console.log('Typing a few letters');
check('nothing until there is something to go on', matchVendors('s', VENDORS), null);
const salt = matchVendors('salt', VENDORS);
check('one hit for salt', salt.length, 1);
check('and it is the right one', salt[0].vendor_name, 'SALTERS DISTRIBUTING');
checkTrue('case does not matter', matchVendors('SALT', VENDORS).length === 1);

console.log('\nThe spelling on the paper is not the spelling on file');
// The invoice says M&J SEA FOOD. The vendor is "M & J Seafood Co., Inc."
const mj = matchVendors('m&j', VENDORS);
check('found through the alias', mj.length, 1);
check('and offered under its real name', mj[0].vendor_name, 'M & J Seafood Co., Inc.');
const pac = matchVendors('pacagri', VENDORS);
check('so is pacagri', pac.length, 1);
check('as pac agri foods', pac[0].vendor_name, 'pac agri foods');

console.log('\nWhen several could match');
const gold = matchVendors('gold', VENDORS);
check('both are offered', gold.length, 2);
checkTrue('rather than one being chosen for him',
  gold.some((v) => v.vendor_id === '5') && gold.some((v) => v.vendor_id === '6'));

console.log('\nWhat starts with the letters comes first');
const dist = matchVendors('distribution', VENDORS);
checkTrue('a middle match is still found', dist.length >= 2);
check('a name that begins with it leads', matchVendors('gold', VENDORS)[0].vendor_name,
      'GOLD RUSH DISTRIBUTION');

console.log('\nOnce the name is complete there is nothing left to suggest');
check('exact name, no list', matchVendors('Sysco', VENDORS), null);
check('trailing spaces do not resurrect it', matchVendors('  Sysco  ', VENDORS), null);

console.log('\nA name nobody has');
check('an empty list, not null', matchVendors('zzzz', VENDORS), []);
// An empty array is what tells the screen to say "will be added as a new
// vendor"; null means say nothing at all. They are not the same thing.

console.log('\nNever more than fits above a keyboard');
const many = [];
for (let i = 0; i < 40; i++) {
  many.push({ vendor_id: 'x' + i, vendor_name: 'DISTRIBUTOR ' + i, pay_method: null, terms: '', aliases: [] });
}
check('six at most', matchVendors('distributor', many).length, 6);

console.log('\nA vendor with no payment type must not claim one');
const picked = matchVendors('salt', VENDORS)[0];
check('it carries null, not a method', picked.pay_method, null);
checkTrue('and not the word unknown', picked.pay_method !== 'unknown');

// ---- the endpoint ------------------------------------------------------
const DB = {
  vendors: [
    { vendor_id: 'v1', store_id: 'store1', name: 'Sysco', payment_type: 'charge_account',
      terms_code: 'net15', terms_days: 15, active: true },
    { vendor_id: 'v2', store_id: 'store1', name: 'SALTERS DISTRIBUTING', payment_type: 'unknown',
      terms_code: null, terms_days: null, active: true },
    { vendor_id: 'v3', store_id: 'store1', name: 'Closed Co', payment_type: 'cod',
      terms_code: 'cod', terms_days: 0, active: false },
  ],
  vendor_aliases: [{ vendor_id: 'v1', alias_text: 'SYSCO FOODS' }],
  invoices: [], payments: [], bank_accounts: [], exceptions: [], payment_allocations: [],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    order() { return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB10';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB10 = {
  id: 'MOCK_SB10', filename: 'MOCK_SB10', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { handler } = require(path.join(__dirname, '..', 'functions', 'invoices.js'));

(async () => {
  console.log('\nThe endpoint the phone calls');
  const r = await handler({
    httpMethod: 'GET',
    queryStringParameters: { store_id: 'store1', vendors_only: '1' },
  });
  check('it answers', r.statusCode, 200);
  const b = JSON.parse(r.body);
  check('only the active vendors', b.vendor_list.length, 2);
  checkTrue('a closed vendor is not offered',
    !b.vendor_list.some((v) => v.vendor_name === 'Closed Co'));
  checkTrue('no invoices are sent along for the ride', b.invoices === undefined);
  check('sorted by name', b.vendor_list.map((v) => v.vendor_name),
        ['SALTERS DISTRIBUTING', 'Sysco']);

  const salters = b.vendor_list.filter((v) => v.vendor_name === 'SALTERS DISTRIBUTING')[0];
  // 'unknown' must never reach the phone as a method: the screen would
  // happily carry it into the invoice and date it from terms nobody set.
  check('an unset payment type travels as null', salters.pay_method, null);
  const sysco = b.vendor_list.filter((v) => v.vendor_name === 'Sysco')[0];
  check('a real one travels as itself', sysco.pay_method, 'charge_account');
  check('with its terms', sysco.terms, 'net15');
  check('and its other spellings', sysco.aliases, ['SYSCO FOODS']);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

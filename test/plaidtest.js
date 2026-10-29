// Tests the bank connection, and above all the sign.
//
// Plaid says POSITIVE for money leaving the account. This system says
// NEGATIVE. Getting that backwards once already put $811,139 of phantom
// money into the account and made a $16,682 check read as a deposit. It is
// the first thing tested here and it is tested from both directions.

const path = require('path');
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB11';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB11 = {
  id: 'MOCK_SB11', filename: 'MOCK_SB11', loaded: true,
  exports: { createClient: () => ({ from: () => ({}) }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { toLedgerAmount, toRow } = require(path.join(__dirname, '..', 'functions', 'plaid-sync.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

console.log('The sign, which is the opposite of ours');
// Plaid: "Positive values when money moves out of the account; negative
// values when money moves in."
check('a check leaves the account', toLedgerAmount(149.12), -149.12);
check('a card purchase leaves the account', toLedgerAmount(516.32), -516.32);
check('a deposit comes in', toLedgerAmount(-15218.40), 15218.40);
check('a refund comes in', toLedgerAmount(-42.00), 42.00);
check('zero stays zero', toLedgerAmount(0), 0);
checkTrue('and nothing is passed through unchanged',
  toLedgerAmount(149.12) !== 149.12,
  'if this ever passes through, every check becomes a deposit');

console.log('\nThe whole year would come out backwards');
// The real file: $7,606,802.13 out, $7,615,677.17 in. Flipped, the account
// looks like it gained seven and a half million dollars.
const YEAR_OUT = 7606802.13;
const YEAR_IN = 7615677.17;
const converted = money(toLedgerAmount(YEAR_OUT) + toLedgerAmount(-YEAR_IN));
check('net comes out the right way round', converted, money(YEAR_IN - YEAR_OUT));
checkTrue('which is a few thousand, not a few million',
  Math.abs(converted) < 50000, String(converted));

console.log('\nA check from the bank');
const CHECK = {
  transaction_id: 'tx_abc123',
  account_id: 'acct_1',
  date: '2026-10-26',
  name: 'CHECK 6742',
  merchant_name: null,
  amount: 149.12,
  check_number: '6742',
  pending: false,
  pending_transaction_id: null,
};
const row = toRow(CHECK, 'store1', 'uuid-acct');
check('stored as money out', row.amount, -149.12);
check('typed as a debit', row.txn_type, 'debit');
check('the check number comes from the bank, as a number', row.check_number, 6742);
check('posted, not pending', row.is_pending, false);
check('carries Plaid\'s own id', row.plaid_transaction_id, 'tx_abc123');
checkTrue('and that id is what makes it unique here',
  row.import_hash === 'plaid:tx_abc123');

console.log('\nA deposit');
const DEP = {
  transaction_id: 'tx_dep1', account_id: 'acct_1', date: '2026-10-26',
  name: 'DEPOSIT    MERCHANT BNKCD CCD', amount: -15218.40,
  check_number: null, pending: false, pending_transaction_id: null,
};
const dep = toRow(DEP, 'store1', 'uuid-acct');
check('stored as money in', dep.amount, 15218.40);
check('typed as a credit', dep.txn_type, 'credit');
check('no check number invented', dep.check_number, null);

console.log('\nTwo identical deposits in one day');
// The flaw that cost $760 under the old fingerprint. Plaid gives each its
// own id, so there is nothing to collapse.
const a = toRow({ transaction_id: 'tx_1', account_id: 'acct_1', date: '2026-03-11',
  name: 'DEPOSIT', amount: -380, pending: false }, 'store1', 'u');
const b = toRow({ transaction_id: 'tx_2', account_id: 'acct_1', date: '2026-03-11',
  name: 'DEPOSIT', amount: -380, pending: false }, 'store1', 'u');
checkTrue('they are two rows, not one', a.import_hash !== b.import_hash);
check('and both are money in', [a.amount, b.amount], [380, 380]);

console.log('\nA pending transaction');
const PEND = {
  transaction_id: 'tx_pending', account_id: 'acct_1', date: '2026-10-28',
  name: 'DBT CRD PROGRESSIVE INS', amount: 516.32,
  check_number: null, pending: true, pending_transaction_id: null,
};
const pend = toRow(PEND, 'store1', 'u');
check('is marked pending', pend.is_pending, true);
check('still signed correctly', pend.amount, -516.32);

console.log('\nThe posted version that replaces it');
const POSTED = {
  transaction_id: 'tx_posted', account_id: 'acct_1', date: '2026-10-29',
  name: 'DBT CRD PROGRESSIVE INS', amount: 516.32,
  check_number: null, pending: false, pending_transaction_id: 'tx_pending',
};
const posted = toRow(POSTED, 'store1', 'u');
check('names the pending one it replaces', posted.plaid_pending_id, 'tx_pending');
check('and is itself posted', posted.is_pending, false);
checkTrue('it is a different row from the pending one',
  posted.plaid_transaction_id !== pend.plaid_transaction_id);
// The sync deletes the row named by plaid_pending_id before writing this
// one, so a pending item that posts does not end up counted twice.

console.log('\nA description it cannot do without');
const BARE = toRow({ transaction_id: 'tx_bare', account_id: 'acct_1',
  date: '2026-10-26', amount: 10, pending: false }, 'store1', 'u');
checkTrue('never empty', !!BARE.description, BARE.description);

console.log('\nThe connection endpoint never hands out the credential');
const fs = require('fs');
const LINK = fs.readFileSync(
  path.join(__dirname, '..', 'functions', 'plaid-link.js'), 'utf8');
// The access token can read every transaction on the account. A browser has
// no use for it, so the GET selects columns by name and that list must not
// grow to include it.
const selected = (LINK.match(/\.select\('([^']*item_id[^']*)'\)/) || [])[1] || '';
checkTrue('the status call selects named columns', selected.length > 0);
checkTrue('and access_token is not among them',
  selected.indexOf('access_token') === -1, selected);
checkTrue('disconnect tells Plaid as well as forgetting it here',
  LINK.indexOf('/item/remove') > -1);

function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

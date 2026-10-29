// Tests corrections: the counted figure wins, and the fact that it was
// corrected survives.

const path = require('path');
const Module = require('module');

const DB = {
  bank_accounts: [{ account_id: 'a1', store_id: 'store1', nickname: 'operating',
                    last_four: '5269', current_balance: 24692.69,
                    balance_as_of: '2026-09-15', active: true }],
  cash_ledger: [],
  exceptions: [],
  payments: [{ payment_id: 'p1', store_id: 'store1', method: 'check', check_number: 5101,
               amount: 860, status: 'outstanding', void_reason: null }],
  invoices: [{ invoice_id: 'i1', store_id: 'store1', invoice_number: '884412',
               total_amount: 4200, amount_paid: 0, balance_due: 4200, status: 'approved' }],
  bank_transactions: [{ bank_txn_id: 't1', store_id: 'store1', match_status: 'matched',
                        matched_type: 'payment', matched_id: 'p1' }],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  let pending = null;
  let where = {};
  const api = {
    select() { return api; },
    eq(col, val) {
      if (pending) { where[col] = val; return api; }
      rows = rows.filter((r) => r[col] === val); return api;
    },
    neq(col, val) { rows = rows.filter((r) => r[col] !== val); return api; },
    order(col, opts) {
      const dir = opts && opts.ascending === false ? -1 : 1;
      rows = rows.slice().sort((a, b) =>
        String(a[col]) < String(b[col]) ? -dir : String(a[col]) > String(b[col]) ? dir : 0);
      return api;
    },
    limit(n) { rows = rows.slice(0, n); return api; },
    insert(p) {
      (Array.isArray(p) ? p : [p]).forEach((r) => {
        if (table === 'invoices' && 'balance_due' in r) {
          throw new Error('cannot insert a non-DEFAULT value into column "balance_due"');
        }
        // Postgres enforces this and the mock did not, so a correction that
        // could never be saved looked saved in every test run. The screen
        // answered 'violates check constraint "cash_ledger_entry_type_check"'
        // the first time Raz counted a drawer.
        if (table === 'cash_ledger') {
          const allowed = ['drawer_float', 'pickup', 'safe_in', 'safe_out',
                           'bank_deposit', 'paid_out', 'cod_payment', 'count'];
          if (allowed.indexOf(r.entry_type) < 0) {
            throw new Error('new row for relation "cash_ledger" violates check '
              + 'constraint "cash_ledger_entry_type_check"');
          }
        }
        DB[table].push(Object.assign(
          { created_at: new Date().toISOString(),
            entry_id: String(10000 + (DB[table] || []).length) }, r));
      });
      return api;
    },
    update(patch) {
      if (table === 'invoices' && 'balance_due' in patch) {
        throw new Error('cannot insert a non-DEFAULT value into column "balance_due"');
      }
      pending = { patch }; where = {}; return api;
    },
    then(res) {
      if (pending) {
        const p = pending; pending = null;
        const w = where; where = {};
        (DB[table] || []).forEach((r) => {
          if (Object.keys(w).every((k) => r[k] === w[k])) Object.assign(r, p.patch);
        });
        return Promise.resolve({ data: null, error: null }).then(res);
      }
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB6';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB6 = {
  id: 'MOCK_SB6', filename: 'MOCK_SB6', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { handler } = require(path.join(__dirname, '..', 'functions', 'correct.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const POST = (b) => handler({ httpMethod: 'POST', body: JSON.stringify(Object.assign({ store_id: 'store1' }, b)) });
const GET = () => handler({ httpMethod: 'GET', queryStringParameters: { store_id: 'store1' } });

(async () => {
  console.log('Correcting the bank balance');
  let r = JSON.parse((await POST({ target: 'bank', amount: '24,100.50', note: 'statement says this' })).body);
  check('it reports what it was', r.was, 24692.69);
  check('and what it now is', r.now, 24100.5);
  check('the account really changed', DB.bank_accounts[0].current_balance, 24100.5);
  checkTrue('a comma in the figure is fine', r.now === 24100.5);

  console.log('\nThe correction is on the record');
  const log = DB.exceptions.filter((e) => e.code === 'CORRECTION');
  check('one entry', log.length, 1);
  checkTrue('it says both figures',
    log[0].message.indexOf('24692.69') > -1 && log[0].message.indexOf('24100.50') > -1,
    log[0].message);
  check('and the reason given', log[0].suggested_action, 'statement says this');

  console.log('\nA correction with no reason still records that');
  await POST({ target: 'bank', amount: 100, note: '' });
  const last = DB.exceptions.filter((e) => e.code === 'CORRECTION').pop();
  check('says no reason was given', last.suggested_action, 'No reason given');

  console.log('\nCounting the cash');
  r = JSON.parse((await POST({ target: 'cash', amount: 4312.25, note: 'counted drawer and safe' })).body);
  check('nothing was there before', r.was, null);
  check('now it is the counted figure', r.now, 4312.25);
  check('and it is in the ledger', DB.cash_ledger.length, 1);
  check('as a count', DB.cash_ledger[0].entry_type, 'count');

  console.log('\nCounting again replaces what it was');
  r = JSON.parse((await POST({ target: 'cash', amount: 4000, note: 'recount' })).body);
  check('it knows the previous count', r.was, 4312.25);
  check('and the new one', r.now, 4000);

  console.log('\nWhat the screen reads back');
  const g = JSON.parse((await GET()).body);
  check('the bank figure', g.bank.amount, 100);
  check('the cash figure', g.cash.amount, 4000);
  checkTrue('and the history of corrections', g.corrections.length >= 4, String(g.corrections.length));

  console.log('\nWhat it refuses');
  check('no target', (await POST({ amount: 5 })).statusCode, 400);
  check('no amount', (await POST({ target: 'cash' })).statusCode, 400);
  check('nonsense amount', (await POST({ target: 'cash', amount: 'abc' })).statusCode, 400);
  check('half a number', (await POST({ target: 'cash', amount: '12.3.4' })).statusCode, 400);
  check('an empty string', (await POST({ target: 'cash', amount: '' })).statusCode, 400);
  checkTrue('and none of those touched the cash figure',
    DB.cash_ledger[DB.cash_ledger.length - 1].amount === 4000,
    String(DB.cash_ledger[DB.cash_ledger.length - 1].amount));
  check('negative cash is refused', (await POST({ target: 'cash', amount: -5 })).statusCode, 400);
  check('a target it does not know', (await POST({ target: 'moon', amount: 5 })).statusCode, 400);

  console.log('\nUndoing a check');
  r = JSON.parse((await POST({ action: 'void', kind: 'check', id: 'p1', note: 'written twice' })).body);
  check('voided', DB.payments[0].status, 'void');
  check('with the reason on the record', DB.payments[0].void_reason, 'written twice');
  checkTrue('and it reports what it was', r.before.check_number === 5101);

  console.log('\nUndoing an invoice');
  await POST({ action: 'void', kind: 'invoice', id: 'i1', note: 'duplicate' });
  check('voided', DB.invoices[0].status, 'void');
  checkTrue('and balance_due was never written',
    DB.invoices[0].balance_due === 4200, 'the generated column must be left alone');

  console.log('\nUndoing a wrong bank match');
  await POST({ action: 'void', kind: 'bank_txn', id: 't1', note: 'matched the wrong check' });
  check('it goes back to unmatched', DB.bank_transactions[0].match_status, 'unmatched');
  check('and forgets what it was matched to', DB.bank_transactions[0].matched_id, null);

  console.log('\nEvery undo is on the record too');
  const voids = DB.exceptions.filter((e) => String(e.message).indexOf('Voided') === 0);
  check('three of them', voids.length, 3);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

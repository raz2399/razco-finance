// Tests the bank matcher on the cases that cost real money:
// two checks for the same amount, a check that cleared for a different
// amount than it was written for, and vendor drafts that carry no number.

const path = require('path');
const Module = require('module');
// Signed in. The endpoints refuse anyone who is not; that is tested on
// its own in authtest, not again in every suite.
require('./stub-guard');

// ---- a Supabase stand-in that records every write ------------------------
const DB = {
  payments: [],
  invoices: [],
  bank_transactions: [],
  bank_accounts: [{ account_id: 'acct-1', store_id: 'store1', nickname: 'operating',
                    last_four: '5269', current_balance: 10000, active: true }],
  exceptions: [],
};
const WRITES = { payments: [], invoices: [], bank_transactions: [], exceptions: [] };

function query(table) {
  let rows = (DB[table] || []).slice();
  let pending = null;
  let justInserted = null;   // insert().select() must return the NEW rows
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
    order() { return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    single() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    insert(payload) {
      const list = Array.isArray(payload) ? payload : [payload];
      list.forEach((r) => {
        const row = Object.assign({}, r);
        if (table === 'bank_transactions' && !row.bank_txn_id) row.bank_txn_id = 'txn-' + (DB[table].length + 1);
        DB[table].push(row);
        WRITES[table].push({ op: 'insert', row });
        justInserted = (justInserted || []).concat([row]);
      });
      return api;
    },
    update(patch) {
      // Postgres refuses any value for a generated column, even the right
      // one. The mock refuses it too, so a write that would fail in
      // production fails here instead of silently passing.
      if (table === 'invoices' && 'balance_due' in patch) {
        throw new Error('cannot insert a non-DEFAULT value into column "balance_due"');
      }
      pending = { op: 'update', patch };
      return api;
    },
    upsert(payload) {
      const list = Array.isArray(payload) ? payload : [payload];
      list.forEach((r) => {
        const key = table === 'bank_accounts' ? 'account_id' : 'id';
        const existing = (DB[table] || []).filter((x) => x[key] && x[key] === r[key])[0];
        if (existing) { Object.assign(existing, r); WRITES[table] = WRITES[table] || []; }
        else { DB[table].push(Object.assign({}, r)); }
      });
      return api;
    },
    then(res) {
      if (pending && pending.op === 'update') {
        const p = pending; pending = null;
        (DB[table] || []).forEach((r) => {
          const hit = Object.keys(p.where || {}).every((k) => r[k] === p.where[k]);
          if (hit) {
            Object.assign(r, p.patch);
            // generated: balance_due = total_amount - amount_paid
            if (table === 'invoices') {
              r.balance_due = Number(r.total_amount || 0) - Number(r.amount_paid || 0);
            }
            WRITES[table].push({ op: 'update', where: p.where, patch: p.patch });
          }
        });
        return Promise.resolve({ data: null, error: null }).then(res);
      }
      if (justInserted) {
        const made = justInserted; justInserted = null;
        return Promise.resolve({ data: made, error: null }).then(res);
      }
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB = {
  id: 'MOCK_SB', filename: 'MOCK_SB', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

// The function reads the PostgREST schema over fetch; answer with the
// columns these tables really have.
const COLS = {
  bank_transactions: ['bank_txn_id', 'account_id', 'store_id', 'posted_date', 'description',
    'amount', 'check_number', 'import_batch', 'import_hash', 'match_status', 'matched_type', 'matched_id'],
  bank_accounts: ['account_id', 'store_id', 'nickname', 'bank_name', 'last_four',
    'current_balance', 'balance_as_of', 'active', 'next_check_number'],
  payments: ['payment_id', 'store_id', 'method', 'amount', 'check_number', 'status', 'cleared_date'],
  invoices: ['invoice_id', 'store_id', 'total_amount', 'balance_due', 'amount_paid', 'status', 'payment_type'],
  exceptions: ['exception_id', 'store_id', 'raised_by', 'severity', 'code', 'entity_type',
    'entity_id', 'message', 'suggested_action', 'status'],
};
global.fetch = async () => ({
  json: async () => ({
    definitions: Object.keys(COLS).reduce((acc, t) => {
      acc[t] = { required: [], properties: COLS[t].reduce((p, c) => { p[c] = { type: 'string' }; return p; }, {}) };
      return acc;
    }, {}),
  }),
});

const { handler } = require(path.join(__dirname, '..', 'functions', 'bank-import.js'));

let pass = 0, fail = 0;
const check = (name, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (name, cond, note) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (note ? ' (' + note + ')' : '')); }
};

const cleared = (n) => DB.payments.filter((p) => Number(p.check_number) === n)[0];

(async () => {
  // Two checks for exactly $500. One of them is named on the statement.
  DB.payments = [
    { payment_id: 'p-501', store_id: 'store1', method: 'check', check_number: 5101, amount: 500.00, status: 'outstanding', cleared_date: null },
    { payment_id: 'p-502', store_id: 'store1', method: 'check', check_number: 5102, amount: 500.00, status: 'outstanding', cleared_date: null },
    { payment_id: 'p-503', store_id: 'store1', method: 'check', check_number: 5103, amount: 1250.00, status: 'outstanding', cleared_date: null },
    // written for 900, cleared for 905 — a hand-written amount the bank read differently
    { payment_id: 'p-504', store_id: 'store1', method: 'check', check_number: 5104, amount: 900.00, status: 'outstanding', cleared_date: null },
  ];
  DB.invoices = [
    { invoice_id: 'inv-1', store_id: 'store1', payment_type: 'cod_draft', total_amount: 3000, balance_due: 3000, status: 'draft_pending', due_date: '2026-10-06' },
    { invoice_id: 'inv-2', store_id: 'store1', payment_type: 'auto_debit', total_amount: 740.25, balance_due: 740.25, status: 'scheduled', due_date: '2026-10-09' },
  ];

  const csv = [
    'Date,Description,Amount',
    '10/05/2026,CHECK 5102,-500.00',
    '10/06/2026,ACH DEBIT C&S WHOLESALE,-3000.00',
    '10/07/2026,CHECK# 5104,-905.00',
    '10/08/2026,CHECK 5103,-1250.00',
    '10/09/2026,TONYS FINE FOODS DRAFT,-740.25',
    '10/10/2026,DEPOSIT,4000.00',
  ].join('\n');

  const res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ store_id: 'store1', account_id: 'acct-1', csv_text: csv }),
  });
  const out = JSON.parse(res.body);
  if (res.statusCode !== 200) { console.log('handler failed: ' + res.body); process.exit(1); }

  console.log('\nCheck number beats amount');
  checkTrue('5102 cleared, not 5101', cleared(5102).status === 'cleared' && cleared(5101).status === 'outstanding',
    '5101 is still outstanding: ' + cleared(5101).status);
  check('5102 carries the bank posting date', cleared(5102).cleared_date, '2026-10-05');
  checkTrue('5101 was never touched', cleared(5101).cleared_date === null);

  console.log('\nA check that cleared for a different amount');
  checkTrue('5104 cleared on its number', cleared(5104).status === 'cleared');
  const how = (out.cleared_how || []).filter((h) => Number(h.check_number) === 5104)[0];
  checkTrue('and the mismatch is reported, not hidden', how && how.amount_differs === true,
    JSON.stringify(how));

  console.log('\nOrdinary exact match');
  checkTrue('5103 cleared', cleared(5103).status === 'cleared');

  console.log('\nVendor drafts, which carry no check number');
  const inv1 = DB.invoices.filter((i) => i.invoice_id === 'inv-1')[0];
  const inv2 = DB.invoices.filter((i) => i.invoice_id === 'inv-2')[0];
  check('the COD draft is marked paid', inv1.status, 'paid');
  check('amount paid is the full invoice', Number(inv1.amount_paid), 3000);
  check('so the generated balance works out to zero', Number(inv1.balance_due), 0);
  check('the auto-debit is paid too', inv2.status, 'paid');
  check('two drafts cleared', out.cleared_drafts, 2);

  console.log('\nDeposits are left alone');
  const deposit = DB.bank_transactions.filter((t) => Number(t.amount) > 0)[0];
  check('a credit is never matched to a check', deposit.match_status, 'unmatched');

  console.log('\nNothing is cleared on a guess');
  checkTrue('no ambiguity in this batch', (out.needs_a_human || []).length === 0,
    JSON.stringify(out.needs_a_human));

  // ---- second batch: the dangerous case ----------------------------------
  DB.bank_transactions = [];
  DB.exceptions = [];
  DB.payments = [
    { payment_id: 'q-1', store_id: 'store1', method: 'check', check_number: 6001, amount: 750.00, status: 'outstanding', cleared_date: null },
    { payment_id: 'q-2', store_id: 'store1', method: 'check', check_number: 6002, amount: 750.00, status: 'outstanding', cleared_date: null },
  ];
  DB.invoices = [];

  const csv2 = [
    'Date,Description,Amount',
    '10/12/2026,PAPER DRAFT WITHDRAWAL,-750.00',
  ].join('\n');

  const res2 = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ store_id: 'store1', account_id: 'acct-1', csv_text: csv2 }),
  });
  const out2 = JSON.parse(res2.body);

  console.log('\nTwo checks, same amount, no number on the statement');
  checkTrue('neither check is cleared',
    DB.payments.every((p) => p.status === 'outstanding'),
    JSON.stringify(DB.payments.map((p) => p.check_number + ':' + p.status)));
  check('it is handed to a human instead', (out2.needs_a_human || []).length, 1);
  checkTrue('and both candidates are named',
    (out2.needs_a_human[0].candidates || []).length === 2,
    JSON.stringify(out2.needs_a_human));
  checkTrue('an exception is filed so it is not forgotten',
    DB.exceptions.length === 1 && DB.exceptions[0].code === 'AMBIGUOUS_MATCH',
    JSON.stringify(DB.exceptions));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

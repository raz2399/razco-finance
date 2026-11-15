// Putting a wrong check number right.
//
// Check 9960 went into the books as 9986, because the next-free number
// was read off the highest ever used and a stray 9999 from September sat
// in the way. That bug is fixed. The wrong number it left behind was not
// correctable from anywhere in the app, and nor was any of the ordinary
// kind: a digit read wrong off the stub, two checks logged on one number.
//
// A check number is how he and the bank talk about the same piece of
// paper, so almost everything here is about refusing to change one:
//
//   - onto a number another check already uses, which makes the two
//     impossible to tell apart on a statement
//   - on a check the bank has already matched, where the bank's number
//     is the true one and renumbering would break the match and send the
//     money looking for a second home
//
// And one thing it must always do: leave the old number on the record,
// because a correction nobody can trace is indistinguishable a year
// later from a mistake nobody caught.

const path = require('path');
const Module = require('module');
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

const PAYMENT_STATUSES = ['draft', 'pending_approval', 'approved', 'issued',
  'outstanding', 'cleared', 'void', 'stopped'];

let DB;

function reset() {
  DB = {
    bank_accounts: [{ account_id: 'acct-1', store_id: 'store1' }],
    payments: [
      // The real one: logged as 9986, actually written as 9960.
      { payment_id: 'p-wrong', store_id: 'store1', method: 'check',
        check_number: '9986', amount: 4200, payment_date: '2026-11-03',
        memo: 'C&S GROCERY', status: 'outstanding', bank_txn_id: null },
      // Already on the number he might mistype into.
      { payment_id: 'p-taken', store_id: 'store1', method: 'check',
        check_number: '9961', amount: 880.25, payment_date: '2026-11-04',
        memo: 'OK PRODUCE', status: 'outstanding', bank_txn_id: null },
      // The bank has matched this one, so its number is settled.
      { payment_id: 'p-cleared', store_id: 'store1', method: 'check',
        check_number: '9940', amount: 1213.73, payment_date: '2026-10-30',
        memo: 'SYSCO', status: 'cleared', bank_txn_id: 'bt-1' },
      // Somebody else's books entirely.
      { payment_id: 'p-other', store_id: 'store2', method: 'check',
        check_number: '9986', amount: 50, payment_date: '2026-11-03',
        memo: 'not his', status: 'outstanding', bank_txn_id: null },
    ],
    bank_transactions: [
      { bank_txn_id: 'bt-9960', store_id: 'store1', check_number: '9960',
        posted_date: '2026-11-05', amount: -4200 },
    ],
    vendors: [],
    invoices: [],
    payment_allocations: [],
    exceptions: [],
  };
}

function enforce(table, row) {
  if (table === 'payments' && row.status != null
      && PAYMENT_STATUSES.indexOf(row.status) === -1) {
    throw new Error('new row violates check constraint "payments_status_check"');
  }
}

function query(table) {
  let filters = [];
  let pending = null;
  let work = null;
  let error = null;
  const copy = (rows) => rows.map((r) => Object.assign({}, r));

  function settleWork() {
    if (!work) return;
    const run = work;
    work = null;
    try { pending = run(); } catch (e) { error = { message: e.message }; }
  }

  const matching = () => (DB[table] || []).filter((r) => filters.every((f) => f(r)));

  const api = {
    select() { return api; },
    eq(col, val) { filters.push((r) => r[col] === val); return api; },
    neq(col, val) { filters.push((r) => r[col] !== val); return api; },
    in(col, vals) { filters.push((r) => vals.indexOf(r[col]) > -1); return api; },
    is(col, val) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return api; },
    gte() { return api; },
    lte() { return api; },
    lt() { return api; },
    ilike() { return api; },
    order() { return api; },
    range() { return api; },
    limit(n) { api._limit = n; return api; },

    insert(payload) {
      const made = [];
      try {
        (Array.isArray(payload) ? payload : [payload]).forEach((r) => {
          enforce(table, r);
          const row = Object.assign({}, r);
          if (table === 'payments' && !row.payment_id) {
            row.payment_id = 'new-' + (DB.payments.length + 1);
          }
          DB[table].push(row);
          made.push(row);
        });
        pending = made;
      } catch (e) { error = { message: e.message }; }
      return api;
    },

    // Deferred: supabase-js writes .update(patch).eq(...), so the filters
    // saying WHICH rows do not exist yet when update() is called.
    update(patch) {
      work = () => {
        const hit = matching();
        hit.forEach((r) => {
          enforce(table, Object.assign({}, r, patch));
          Object.assign(r, patch);
        });
        return hit;
      };
      return api;
    },

    maybeSingle() {
      settleWork();
      if (error) return Promise.resolve({ data: null, error: error });
      const rows = copy(pending || matching());
      return Promise.resolve({ data: rows[0] || null, error: null });
    },
    single() {
      settleWork();
      if (error) return Promise.resolve({ data: null, error: error });
      const rows = copy(pending || matching());
      return Promise.resolve({
        data: rows[0] || null,
        error: rows.length ? null : { message: 'no rows' },
      });
    },
    then(res) {
      settleWork();
      if (error) return Promise.resolve({ data: null, error: error }).then(res);
      let rows = copy(pending || matching());
      if (api._limit) rows = rows.slice(0, api._limit);
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB_RENUM';
  return origResolve.apply(this, arguments);
};
require.cache.MOCK_SB_RENUM = {
  id: 'MOCK_SB_RENUM', filename: 'MOCK_SB_RENUM', loaded: true,
  exports: {
    createClient: () => ({
      from: query,
      auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    }),
  },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { handler } = require(path.join(ROOT, 'functions', 'checks.js'));

let pass = 0;
let fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else {
    fail++;
    console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a)
      + '\n       expected ' + JSON.stringify(b));
  }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const POST = async (payload) => {
  const r = await handler({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer t' },
    queryStringParameters: { store_id: 'store1' },
    body: JSON.stringify(Object.assign({ store_id: 'store1' }, payload)),
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

const row = (id) => DB.payments.filter((p) => p.payment_id === id)[0];

(async () => {
  console.log('Correcting a number');
  reset();
  let r = await POST({ action: 'renumber', payment_id: 'p-wrong', check_number: '9960' });
  check('accepted', r.status, 200);
  check('the check now carries the right number', row('p-wrong').check_number, '9960');
  checkTrue('and the old one is on the record',
    /was check 9986/.test(row('p-wrong').memo || ''), row('p-wrong').memo);
  checkTrue('what it was and what it is are both reported',
    r.body.was === '9986' && r.body.now === '9960', JSON.stringify(r.body));

  // The whole reason he is correcting it: a bank line under the real
  // number has been sitting there unmatched.
  checkTrue('it points out the bank line waiting under that number',
    /bank shows a check 9960/.test(r.body.note || ''), r.body.note);

  console.log('\nRefusing a number already in use');
  reset();
  r = await POST({ action: 'renumber', payment_id: 'p-wrong', check_number: '9961' });
  check('refused', r.status, 409);
  check('and nothing was changed', row('p-wrong').check_number, '9986');
  checkTrue('it says which check is in the way',
    /9961 is already used/.test(r.body.error || ''), r.body.error);
  checkTrue('with the amount and date, so he can tell them apart',
    /880\.25/.test(r.body.error || '') && /2026-11-04/.test(r.body.error || ''),
    r.body.error);

  console.log('\nRefusing to renumber what the bank has matched');
  reset();
  r = await POST({ action: 'renumber', payment_id: 'p-cleared', check_number: '9941' });
  check('refused', r.status, 409);
  check('the matched check keeps its number', row('p-cleared').check_number, '9940');
  checkTrue('because the bank is the one that knows',
    /break the match/.test(r.body.error || ''), r.body.error);

  console.log('\nThe ordinary refusals');
  reset();
  r = await POST({ action: 'renumber', payment_id: 'p-wrong', check_number: '99 60' });
  check('a number with a space in it is not a check number', r.status, 400);
  check('nothing changed', row('p-wrong').check_number, '9986');

  r = await POST({ action: 'renumber', payment_id: 'p-wrong', check_number: '' });
  check('an empty number is refused', r.status, 400);

  r = await POST({ action: 'renumber', check_number: '9960' });
  check('no check named is refused', r.status, 400);

  r = await POST({ action: 'renumber', payment_id: 'p-nope', check_number: '9960' });
  check('a check that does not exist is refused', r.status, 404);

  r = await POST({ action: 'renumber', payment_id: 'p-wrong', check_number: '9986' });
  check('setting it to the number it already has is harmless', r.status, 200);
  check('and leaves it alone', row('p-wrong').check_number, '9986');
  checkTrue('without scribbling "was check 9986" on its own memo',
    (row('p-wrong').memo || '').indexOf('was check') === -1, row('p-wrong').memo);

  console.log('\nAnother store cannot be touched');
  reset();
  // store2 also has a check 9986. Renumbering his must neither find it
  // nor be blocked by it.
  r = await POST({ action: 'renumber', payment_id: 'p-other', check_number: '9970' });
  check('a check in another store is not found', r.status, 404);
  check('and is left exactly as it was', row('p-other').check_number, '9986');

  reset();
  r = await POST({ action: 'renumber', payment_id: 'p-wrong', check_number: '9986' });
  checkTrue('and another store holding that number does not block his',
    r.status === 200, 'got ' + r.status);

  console.log('\nrenum: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();

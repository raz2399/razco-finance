// Removing a transaction that exists twice -- and refusing to remove one
// that only looks like it does.
//
// A statement CSV covering January to October was imported. Then the bank
// was connected and Plaid went back to August, so three months sit in the
// table twice: same day, same amount, different fingerprints.
//
// Deleting the wrong row here deletes a real transaction out of a real
// company's bank history, and the archive is the only reason that is
// recoverable. So the rules this pins are all about restraint:
//
//   - only where a Plaid twin actually exists
//   - one twin claims one CSV row, so two identical $380 deposits on one
//     day stay two
//   - never a row anything has been matched to
//   - never a row from before the bank connection's own history starts
//   - archived first, and a failed archive deletes nothing

const assert = require('assert');
const path = require('path');
const Module = require('module');
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

let DB;
let ARCHIVE;
let DELETED;
let failArchive;

function reset() {
  ARCHIVE = [];
  DELETED = [];
  failArchive = false;
  DB = {
    bank_transactions: [
      // --- before Plaid's history starts: must never be touched -------
      { bank_txn_id: 'old-1', store_id: 'store1', posted_date: '2026-01-05',
        amount: -100, plaid_transaction_id: null, match_status: 'unmatched',
        matched_id: null, description: 'CHECK 1001' },

      // --- a plain duplicate ------------------------------------------
      { bank_txn_id: 'csv-dup', store_id: 'store1', posted_date: '2026-08-10',
        amount: -250.5, plaid_transaction_id: null, match_status: 'unmatched',
        matched_id: null, description: 'PURCHASE C&S WHOLESALE GR CCD' },
      { bank_txn_id: 'plaid-dup', store_id: 'store1', posted_date: '2026-08-10',
        amount: -250.5, plaid_transaction_id: 'p-1', match_status: 'unmatched',
        matched_id: null, description: 'C&S Wholesale' },

      // --- CSV row in the window with NO twin: must stay --------------
      { bank_txn_id: 'csv-lonely', store_id: 'store1', posted_date: '2026-08-11',
        amount: -999.99, plaid_transaction_id: null, match_status: 'unmatched',
        matched_id: null, description: 'SOMETHING PLAID NEVER SENT' },

      // --- two identical CSV rows, only ONE twin ----------------------
      { bank_txn_id: 'csv-twin-a', store_id: 'store1', posted_date: '2026-08-12',
        amount: 380, plaid_transaction_id: null, match_status: 'unmatched',
        matched_id: null, description: 'BUSINESS DEPOSIT' },
      { bank_txn_id: 'csv-twin-b', store_id: 'store1', posted_date: '2026-08-12',
        amount: 380, plaid_transaction_id: null, match_status: 'unmatched',
        matched_id: null, description: 'BUSINESS DEPOSIT' },
      { bank_txn_id: 'plaid-twin', store_id: 'store1', posted_date: '2026-08-12',
        amount: 380, plaid_transaction_id: 'p-2', match_status: 'unmatched',
        matched_id: null, description: 'Deposit' },

      // --- a duplicate that has been MATCHED: must stay ---------------
      { bank_txn_id: 'csv-matched', store_id: 'store1', posted_date: '2026-08-13',
        amount: -1500, plaid_transaction_id: null, match_status: 'matched',
        matched_id: 'pay-1', description: 'CHECK 9887' },
      { bank_txn_id: 'plaid-matched', store_id: 'store1', posted_date: '2026-08-13',
        amount: -1500, plaid_transaction_id: 'p-3', match_status: 'unmatched',
        matched_id: null, description: 'Check 9887' },
    ],
    bank_transactions_csv_superseded: ARCHIVE,
  };
}

function query(table) {
  let rows = (DB[table] || []).slice();
  let isDelete = false;
  let pendingInsert = null;

  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    is(col, val) {
      if (val === null) rows = rows.filter((r) => r[col] === null || r[col] === undefined);
      return api;
    },
    not(col, op, val) {
      if (op === 'is' && val === null) {
        rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
      }
      return api;
    },
    gte(col, val) { rows = rows.filter((r) => String(r[col]) >= val); return api; },
    lte(col, val) { rows = rows.filter((r) => String(r[col]) <= val); return api; },
    order(col, o) {
      rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1));
      if (o && o.ascending === false) rows.reverse();
      return api;
    },
    limit(n) { rows = rows.slice(0, n); return api; },
    range() { return api; },
    maybeSingle() {
      return Promise.resolve({ data: rows[0] || null, error: null });
    },
    delete() { isDelete = true; rows = (DB[table] || []).slice(); return api; },
    insert(payload) { pendingInsert = payload; return api; },
    in(col, vals) {
      if (isDelete) {
        const gone = (DB[table] || []).filter((r) => vals.indexOf(r[col]) > -1);
        DELETED.push.apply(DELETED, gone.map((r) => r.bank_txn_id));
        DB[table] = (DB[table] || []).filter((r) => vals.indexOf(r[col]) === -1);
        return Promise.resolve({ data: gone, error: null });
      }
      rows = rows.filter((r) => vals.indexOf(r[col]) > -1);
      return api;
    },
    then(resolve) {
      if (pendingInsert) {
        if (failArchive) {
          return Promise.resolve({ data: null, error: { message: 'archive is down' } })
            .then(resolve);
        }
        const list = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        list.forEach((r) => ARCHIVE.push(r));
        return Promise.resolve({ data: list, error: null }).then(resolve);
      }
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  return api;
}

const orig = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => ({ from: query }) };
  }
  return orig.apply(this, arguments);
};
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { handler } = require(path.join(ROOT, 'functions', 'bank-match.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch((e) => { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); });
}

const call = (confirm) => handler({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer test' },
  body: JSON.stringify({ store_id: 'store1', action: 'dedupe', confirm: confirm }),
  queryStringParameters: {},
}).then((r) => JSON.parse(r.body));

console.log('\nthe same transaction, twice');

Promise.resolve()
  .then(() => check('a preview changes nothing', () => {
    reset();
    return call(false).then((b) => {
      assert.strictEqual(b.removed, 0);
      assert.strictEqual(DELETED.length, 0, 'it deleted during a preview');
      assert.strictEqual(DB.bank_transactions.length, 9);
    });
  }))

  .then(() => check('it counts only the certain duplicates', () => {
    reset();
    return call(false).then((b) => {
      // Only csv-dup. Not csv-lonely (no twin), not csv-matched (tied to
      // a payment), not old-1 (before the bank's history), and not the
      // $380 pair -- the import holds two and the bank sent one, so the
      // bank plainly did not capture everything that day.
      assert.strictEqual(b.would_remove, 1,
        'wanted to remove ' + b.would_remove + ', expected 1');
    });
  }))

  .then(() => check('a row from before the bank history starts is never touched', () => {
    reset();
    return call(true).then(() => {
      assert.ok(DELETED.indexOf('old-1') === -1, 'deleted a January row');
    });
  }))

  .then(() => check('a CSV row with no twin stays', () => {
    reset();
    return call(true).then(() => {
      assert.ok(DELETED.indexOf('csv-lonely') === -1,
        'deleted a transaction Plaid never sent -- that is real data gone');
    });
  }))

  .then(() => check('when the import has MORE than the bank sent, nothing goes', () => {
    // The dangerous case, and the reason the obvious rule is wrong.
    //
    // "One twin claims one row" would remove one of the pair here. Press
    // the button again and the survivor matches the still-unclaimed
    // Plaid row and goes too -- a genuine $380 deposit, deleted by
    // pressing a button twice. The bank sending fewer copies than the
    // import holds means the bank did not capture everything, so the
    // whole group is left alone and shown to him instead.
    reset();
    return call(true).then(() => {
      const gone = ['csv-twin-a', 'csv-twin-b'].filter((id) => DELETED.indexOf(id) > -1);
      assert.strictEqual(gone.length, 0,
        'removed ' + gone.length + ' of the pair; neither is certain');
    });
  }))

  .then(() => check('and that day is reported rather than silently skipped', () => {
    reset();
    return call(false).then((b) => {
      const look = b.needs_a_look || [];
      assert.strictEqual(look.length, 1, 'should name the one uncertain day');
      assert.strictEqual(look[0].date, '2026-08-12');
      assert.strictEqual(look[0].imported, 2);
      assert.strictEqual(look[0].from_bank, 1);
    });
  }))

  .then(() => check('a matched row is never removed, duplicate or not', () => {
    reset();
    return call(true).then(() => {
      assert.ok(DELETED.indexOf('csv-matched') === -1,
        'deleted a row something was matched to');
    });
  }))

  .then(() => check('the Plaid copies all survive', () => {
    reset();
    return call(true).then(() => {
      ['plaid-dup', 'plaid-twin', 'plaid-matched'].forEach((id) => {
        assert.ok(DELETED.indexOf(id) === -1, 'deleted the bank copy ' + id);
      });
    });
  }))

  .then(() => check('everything removed is archived first', () => {
    reset();
    return call(true).then((b) => {
      assert.strictEqual(b.removed, ARCHIVE.length,
        'removed ' + b.removed + ' but archived ' + ARCHIVE.length);
      DELETED.forEach((id) => {
        assert.ok(ARCHIVE.filter((a) => a.bank_txn_id === id).length === 1,
          id + ' was deleted without being archived');
      });
    });
  }))

  .then(() => check('if the archive fails, NOTHING is deleted', () => {
    reset();
    failArchive = true;
    return call(true).then((b) => {
      assert.ok(b.error, 'it should have refused');
      assert.strictEqual(DELETED.length, 0,
        'deleted ' + DELETED.length + ' rows with no way to get them back');
      assert.strictEqual(DB.bank_transactions.length, 9);
    });
  }))

  .then(() => check('running it twice removes nothing the second time', () => {
    reset();
    return call(true)
      .then(() => { DELETED.length = 0; return call(true); })
      .then((b) => {
        assert.strictEqual(b.removed, 0);
        assert.strictEqual(DELETED.length, 0);
      });
  }))

  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });

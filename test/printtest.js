// Printing checks.
//
// A check number is a serial number on paper that has already come out
// of a printer. Assign one twice and two different checks carry the same
// number: the bank may pay both, reconciliation matches the wrong one,
// and the only trace is a duplicate on a statement months later.
//
// So most of this suite is about refusing to print rather than printing.

const assert = require('assert');
const path = require('path');
const Module = require('module');
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

let DB;
let UPDATES;

function reset() {
  UPDATES = [];
  DB = {
    bank_accounts: [{
      account_id: 'acct-1', store_id: 'store1', nickname: 'operating',
      next_check_number: 1000, check_offset_x: 0, check_offset_y: 0,
      check_layout: 'top',
    }],
    vendors: [
      { vendor_id: 'v-1', store_id: 'store1', name: 'Sysco',
        address_line1: '100 Food Way', city: 'Fresno', state: 'CA', postal_code: '93710' },
      { vendor_id: 'v-2', store_id: 'store1', name: 'RYL PLUMBING' },
    ],
    payments: [
      { payment_id: 'p-1', store_id: 'store1', vendor_id: 'v-1', method: 'check',
        amount: 1234.5, payment_date: '2026-10-30', memo: 'invoice 4471',
        status: 'approved', check_number: null },
      { payment_id: 'p-2', store_id: 'store1', vendor_id: 'v-2', method: 'check',
        amount: 400, payment_date: '2026-10-30', memo: '', status: 'approved',
        check_number: null },
      // already printed -- must never be reprinted
      { payment_id: 'p-done', store_id: 'store1', vendor_id: 'v-1', method: 'check',
        amount: 50, payment_date: '2026-10-01', memo: '', status: 'outstanding',
        check_number: 9887 },
      // a voided check: its number is spent for ever
      { payment_id: 'p-void', store_id: 'store1', vendor_id: 'v-1', method: 'check',
        amount: 75, payment_date: '2026-09-01', memo: '', status: 'void',
        check_number: 6001 },
      // not a check
      { payment_id: 'p-ach', store_id: 'store1', vendor_id: 'v-1', method: 'ach',
        amount: 90, payment_date: '2026-10-30', memo: '', status: 'approved',
        check_number: null },
      // an amount that cannot be written out
      { payment_id: 'p-bad', store_id: 'store1', vendor_id: 'v-1', method: 'check',
        amount: 0, payment_date: '2026-10-30', memo: '', status: 'approved',
        check_number: null },
    ],
    bank_transactions: [
      { bank_txn_id: 'b-1', store_id: 'store1', check_number: 9925, posted_date: '2026-10-30' },
      { bank_txn_id: 'b-2', store_id: 'store1', check_number: 6915, posted_date: '2026-10-27' },
    ],
  };
}

function query(table) {
  let rows = (DB[table] || []).slice();
  let patch = null;
  let isUpdate = false;

  const api = {
    select() { return api; },
    update(p) { isUpdate = true; patch = p; return api; },
    eq(col, val) {
      rows = rows.filter((r) => r[col] === val);
      if (isUpdate) return api;
      return api;
    },
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
    in(col, vals) { rows = rows.filter((r) => vals.indexOf(r[col]) > -1); return api; },
    range() { return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    then(resolve) {
      if (isUpdate) {
        rows.forEach((r) => {
          UPDATES.push({ table: table, id: r.payment_id || r.account_id, patch: patch });
          Object.keys(patch).forEach((k) => { r[k] = patch[k]; });
        });
        return Promise.resolve({ data: rows, error: null }).then(resolve);
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

const { handler } = require(path.join(ROOT, 'functions', 'check-print.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch((e) => { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); });
}

const get = () => handler({
  httpMethod: 'GET',
  headers: { authorization: 'Bearer t' },
  queryStringParameters: { store_id: 'store1' },
}).then((r) => JSON.parse(r.body));

const print = (ids, start) => handler({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer t' },
  queryStringParameters: {},
  body: JSON.stringify({ store_id: 'store1', payment_ids: ids, start_number: start }),
}).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

console.log('\nwhat is waiting');

Promise.resolve()
  .then(() => check('only unprinted checks are offered', () => {
    reset();
    return get().then((b) => {
      const ids = b.waiting.map((w) => w.payment_id);
      assert.ok(ids.indexOf('p-done') === -1, 'offered one already printed');
      assert.ok(ids.indexOf('p-ach') === -1, 'offered an ACH payment');
      assert.ok(ids.indexOf('p-1') > -1 && ids.indexOf('p-2') > -1);
    });
  }))

  .then(() => check('an amount that cannot be written is marked unprintable', () => {
    reset();
    return get().then((b) => {
      const bad = b.waiting.filter((w) => w.payment_id === 'p-bad')[0];
      assert.ok(bad, 'should still be listed');
      assert.strictEqual(bad.printable, false);
    });
  }))

  .then(() => check('the suggested number comes from real checks, not the stored 1000', () => {
    reset();
    return get().then((b) => {
      // The stored next_check_number is 1000. The evidence says the
      // 9000 book is in use and 9925 is the highest seen.
      assert.strictEqual(b.account.stored_next, 1000);
      assert.strictEqual(b.suggested_next, 9926,
        'suggested ' + b.suggested_next + ' -- should follow the book actually in use');
    });
  }))

  .then(() => check('the book in the printer is the one used most recently', () => {
    // Not the one with the most checks in it. Razco runs two books at
    // once, and volume picked the wrong one.
    reset();
    return get().then((b) => {
      assert.strictEqual(b.books[0].series, 9000,
        'picked the ' + b.books[0].series + ' book; 9000 was used three days later');
      assert.strictEqual(b.books[0].last_used, '2026-10-30');
    });
  }))

  .then(() => check('it knows which books are running out', () => {
    reset();
    return get().then((b) => {
      const nine = b.books.filter((x) => x.series === 9000)[0];
      assert.ok(nine, 'should see the 9000 book');
      assert.strictEqual(nine.highest, 9925);
      assert.strictEqual(nine.left_in_book, 74);
      const spent = b.books.filter((x) => x.series === 6000)[0];
      assert.strictEqual(spent.highest, 6915);
    });
  }))

  .then(() => check('a voided number still counts as used', () => {
    reset();
    return get().then((b) => {
      const six = b.books.filter((x) => x.series === 6000)[0];
      assert.ok(six.count >= 2, 'the voided 6001 must be counted -- that paper is spent');
    });
  }))

  .then(() => {
    console.log('\nwhat it refuses to print');
  })

  .then(() => check('a number used before refuses the WHOLE run', () => {
    reset();
    return print(['p-1', 'p-2'], 9925).then((r) => {
      assert.strictEqual(r.status, 409);
      assert.ok(/9925/.test(r.body.error));
      assert.strictEqual(UPDATES.length, 0,
        'it numbered ' + UPDATES.length + ' payments before refusing');
    });
  }))

  .then(() => check('a collision anywhere in the range refuses, not just the first', () => {
    reset();
    // 9924, 9925 -- the second one clashes.
    return print(['p-1', 'p-2'], 9924).then((r) => {
      assert.strictEqual(r.status, 409);
      assert.strictEqual(UPDATES.length, 0);
    });
  }))

  .then(() => check('a voided number is not handed out again', () => {
    reset();
    return print(['p-1'], 6001).then((r) => {
      assert.strictEqual(r.status, 409,
        'reused a voided check number -- that paper exists and is ruined');
    });
  }))

  .then(() => check('a payment that already has a number is never renumbered', () => {
    reset();
    return print(['p-done'], 9930).then((r) => {
      assert.strictEqual(r.status, 409);
      assert.strictEqual(UPDATES.length, 0);
    });
  }))

  .then(() => check('an unwritable amount stops the run before any number is used', () => {
    reset();
    return print(['p-1', 'p-bad'], 9930).then((r) => {
      assert.strictEqual(r.status, 400);
      assert.strictEqual(UPDATES.length, 0,
        'it issued numbers and then found the bad one');
    });
  }))

  .then(() => check('no start number, no printing', () => {
    reset();
    return print(['p-1'], 0).then((r) => {
      assert.strictEqual(r.status, 400);
      assert.strictEqual(UPDATES.length, 0);
    });
  }))

  .then(() => {
    console.log('\nwhat it prints');
  })

  .then(() => check('numbers run in order, and the payments are marked outstanding', () => {
    reset();
    return print(['p-1', 'p-2'], 9930).then((r) => {
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.printed.map((p) => p.check_number), [9930, 9931]);
      const statuses = r.body.printed.map((p) =>
        DB.payments.filter((x) => x.payment_id === p.payment_id)[0].status);
      assert.deepStrictEqual(statuses, ['outstanding', 'outstanding']);
    });
  }))

  .then(() => check('the written line and the box agree, and both are protected', () => {
    reset();
    return print(['p-1'], 9930).then((r) => {
      const c = r.body.printed[0];
      assert.ok(c.amount_words.indexOf(
        'One Thousand Two Hundred Thirty-Four and 50/100') === 0, c.amount_words);
      assert.strictEqual(c.amount_figures, '**1,234.50');
      assert.ok(/\*{5,}$/.test(c.amount_words), 'the line must be filled out');
    });
  }))

  .then(() => check('the payee and address come through', () => {
    reset();
    return print(['p-1'], 9930).then((r) => {
      const c = r.body.printed[0];
      assert.strictEqual(c.payee, 'Sysco');
      assert.ok(c.address.indexOf('100 Food Way') > -1);
      assert.ok(c.address.indexOf('Fresno, CA') > -1);
    });
  }))

  .then(() => check('a vendor with no address still prints', () => {
    reset();
    return print(['p-2'], 9930).then((r) => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.printed[0].payee, 'RYL PLUMBING');
      assert.deepStrictEqual(r.body.printed[0].address, []);
    });
  }))

  .then(() => check('the next number is remembered for the following run', () => {
    reset();
    return print(['p-1', 'p-2'], 9930).then((r) => {
      assert.strictEqual(r.body.next_check_number, 9932);
      assert.strictEqual(DB.bank_accounts[0].next_check_number, 9932);
    });
  }))

  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });

// Deleting things, and refusing to.
//
// Delete and void are different answers to different situations, and
// using the wrong one does real damage in both directions:
//
//   deleting what has history   leaves invoices pointing at a payee that
//                               no longer exists, and a check number
//                               that is spent silently freed for reuse
//
//   voiding what has none       fills the ledger with crossed-out noise
//                               from lines that were typos five seconds
//                               old and never meant anything
//
// So the choice is made from what the row has actually touched, never
// from which button was pressed. These tests pin that.

const assert = require('assert');
const path = require('path');
const Module = require('module');
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

let DB;
let DELETED;
let UPDATED;

// Voiding an invoice releases the payment allocated to it, which is a
// legitimate delete in payment_allocations. What must never be deleted
// is the invoice or the payment itself.
const deletedLedgerRows = () => DELETED.filter((d) =>
  d.table === 'invoices' || d.table === 'payments' || d.table === 'vendors');

function reset() {
  DELETED = [];
  UPDATED = [];
  DB = {
    vendors: [
      { vendor_id: '11111111-1111-4111-8111-111111111111', store_id: 'store1',
        name: 'Sysco', payment_type: 'charge_account', active: true,
        default_category_id: null },
      { vendor_id: '22222222-2222-4222-8222-222222222222', store_id: 'store1',
        name: 'Typo Vendor', payment_type: 'unknown', active: true,
        default_category_id: null },
    ],
    invoices: [
      { invoice_id: '33333333-3333-4333-8333-333333333333', store_id: 'store1',
        vendor_id: '11111111-1111-4111-8111-111111111111', invoice_number: '4471',
        total_amount: 708.19, amount_paid: 0, balance_due: 708.19,
        status: 'approved' },
      { invoice_id: '44444444-4444-4444-8444-444444444444', store_id: 'store1',
        vendor_id: '11111111-1111-4111-8111-111111111111', invoice_number: '4472',
        total_amount: 100, amount_paid: 60, balance_due: 40,
        status: 'partially_paid' },
    ],
    payments: [
      // typed wrong, touched nothing
      { payment_id: '55555555-5555-4555-8555-555555555555', store_id: 'store1',
        vendor_id: '11111111-1111-4111-8111-111111111111', method: 'check',
        amount: 50, status: 'draft', check_number: null, bank_txn_id: null },
      // has a check number: the paper exists
      { payment_id: '66666666-6666-4666-8666-666666666666', store_id: 'store1',
        vendor_id: '11111111-1111-4111-8111-111111111111', method: 'check',
        amount: 900, status: 'outstanding', check_number: 9887, bank_txn_id: null },
      // cleared the bank
      { payment_id: '77777777-7777-4777-8777-777777777777', store_id: 'store1',
        vendor_id: '11111111-1111-4111-8111-111111111111', method: 'ach',
        amount: 300, status: 'cleared', check_number: null, bank_txn_id: 'b-9' },
    ],
    payment_allocations: [
      { allocation_id: 'a-1', payment_id: '88888888-8888-4888-8888-888888888888',
        invoice_id: '44444444-4444-4444-8444-444444444444', amount: 60 },
    ],
    bank_transactions: [],
    exceptions: [],
  };
}

function query(table) {
  let rows = (DB[table] || []).slice();
  let mode = null;
  let patch = null;

  const api = {
    select() { return api; },
    update(p) { mode = 'update'; patch = p; return api; },
    delete() { mode = 'delete'; return api; },
    insert(p) { mode = 'insert'; patch = p; return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    neq(col, val) { rows = rows.filter((r) => r[col] !== val); return api; },
    is(col, val) {
      if (val === null) rows = rows.filter((r) => r[col] === null || r[col] === undefined);
      return api;
    },
    in(col, vals) { rows = rows.filter((r) => vals.indexOf(r[col]) > -1); return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    range() { return api; },
    order() { return api; },
    maybeSingle() { return finish({ data: rows[0] || null, one: true }); },
    single() { return finish({ data: rows[0] || null, one: true }); },
    then(resolve) { return finish({ data: rows }).then(resolve); },
  };

  function finish(result) {
    if (mode === 'update') {
      rows.forEach((r) => {
        UPDATED.push({ table: table, id: r.vendor_id || r.invoice_id || r.payment_id,
                       patch: patch });
        Object.keys(patch).forEach((k) => { r[k] = patch[k]; });
      });
      return Promise.resolve({ data: rows, error: null });
    }
    if (mode === 'delete') {
      rows.forEach((r) => DELETED.push({
        table: table, id: r.vendor_id || r.invoice_id || r.payment_id,
      }));
      const ids = rows.map((r) => r.vendor_id || r.invoice_id || r.payment_id);
      DB[table] = (DB[table] || []).filter((r) => {
        const id = r.vendor_id || r.invoice_id || r.payment_id;
        return ids.indexOf(id) === -1;
      });
      return Promise.resolve({ data: rows, error: null });
    }
    if (mode === 'insert') {
      const list = Array.isArray(patch) ? patch : [patch];
      list.forEach((r) => {
        if (!r.vendor_id) r.vendor_id = 'new-' + (DB[table] || []).length;
        (DB[table] = DB[table] || []).push(r);
      });
      // .single() after an insert returns the row, not a list of one --
      // the real client does, and a mock that does not makes the code
      // look broken when it is the harness that is.
      return Promise.resolve({
        data: result && result.one ? (list[0] || null) : list,
        error: null,
      });
    }
    return Promise.resolve({ data: result.data, error: null });
  }

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

const entry = require(path.join(ROOT, 'functions', 'vendor-entry.js'));
const setup = require(path.join(ROOT, 'functions', 'vendor-setup.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch((e) => { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); });
}

const call = (handler, payload) => handler({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer t' },
  queryStringParameters: {},
  body: JSON.stringify(Object.assign({ store_id: 'store1' }, payload)),
}).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

console.log('\ndeleting a line');

Promise.resolve()
  .then(() => check('a draft that touched nothing is deleted outright', () => {
    reset();
    return call(entry.handler, {
      action: 'delete', kind: 'payment',
      id: '55555555-5555-4555-8555-555555555555',
    }).then((r) => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.deleted, true, r.body.says || r.body.error);
      assert.strictEqual(deletedLedgerRows().length, 1);
    });
  }))

  .then(() => check('a check with a number is VOIDED, never deleted', () => {
    reset();
    return call(entry.handler, {
      action: 'delete', kind: 'payment',
      id: '66666666-6666-4666-8666-666666666666',
    }).then((r) => {
      assert.strictEqual(r.body.voided, true, r.body.says || r.body.error);
      assert.strictEqual(deletedLedgerRows().length, 0,
        'deleted a check that has a number -- that paper exists');
      assert.ok(r.body.why.join(' ').indexOf('9887') > -1,
        'it should say which check and why');
    });
  }))

  .then(() => check('a payment the bank has seen is voided', () => {
    reset();
    return call(entry.handler, {
      action: 'delete', kind: 'payment',
      id: '77777777-7777-4777-8777-777777777777',
    }).then((r) => {
      assert.strictEqual(r.body.voided, true, r.body.says || r.body.error);
      assert.strictEqual(deletedLedgerRows().length, 0);
    });
  }))

  .then(() => check('an invoice with money against it is voided', () => {
    reset();
    return call(entry.handler, {
      action: 'delete', kind: 'invoice',
      id: '44444444-4444-4444-8444-444444444444',
    }).then((r) => {
      assert.strictEqual(r.body.voided, true, r.body.says || r.body.error);
      assert.strictEqual(deletedLedgerRows().length, 0,
        'deleted the invoice itself; only the allocation should be released');
      // And the payment that was against it is handed back, not stranded.
      assert.ok(DELETED.filter((d) => d.table === 'payment_allocations').length > 0,
        'the allocation should be released so the payment is free again');
    });
  }))

  .then(() => check('an untouched invoice is deleted', () => {
    reset();
    return call(entry.handler, {
      action: 'delete', kind: 'invoice',
      id: '33333333-3333-4333-8333-333333333333',
    }).then((r) => {
      assert.strictEqual(r.body.deleted, true, r.body.says || r.body.error);
    });
  }))

  .then(() => check('it says in plain words which one happened and why', () => {
    reset();
    return call(entry.handler, {
      action: 'delete', kind: 'payment',
      id: '66666666-6666-4666-8666-666666666666',
    }).then((r) => {
      assert.ok(/Voided rather than deleted, because/.test(r.body.says), r.body.says);
    });
  }))

  .then(() => { console.log('\nremoving a vendor'); })

  .then(() => check('a vendor with bills is switched off, not deleted', () => {
    reset();
    return call(setup.handler, {
      action: 'remove', vendor_id: '11111111-1111-4111-8111-111111111111',
    }).then((r) => {
      assert.strictEqual(r.body.switched_off, true, r.body.message || r.body.error);
      assert.strictEqual(deletedLedgerRows().length, 0,
        'deleting it would orphan every invoice pointing at it');
      assert.strictEqual(DB.vendors[0].active, false);
    });
  }))

  .then(() => check('a vendor with nothing against it is deleted', () => {
    reset();
    return call(setup.handler, {
      action: 'remove', vendor_id: '22222222-2222-4222-8222-222222222222',
    }).then((r) => {
      assert.strictEqual(r.body.deleted, true, r.body.message || r.body.error);
    });
  }))

  .then(() => { console.log('\nadding a vendor'); })

  .then(() => check('a new vendor can be added', () => {
    reset();
    return call(setup.handler, { action: 'create', name: 'New Produce Co' })
      .then((r) => {
        assert.strictEqual(r.status, 200, r.body.error);
        assert.strictEqual(r.body.vendor.name, 'New Produce Co');
      });
  }))

  .then(() => check('the same name typed differently is caught', () => {
    reset();
    return call(setup.handler, { action: 'create', name: '  sysco ' })
      .then((r) => {
        assert.strictEqual(r.status, 409,
          'let a second Sysco in -- that is how a vendor list rots');
        assert.ok(/already on the list/.test(r.body.error));
      });
  }))

  .then(() => check('but he can insist', () => {
    reset();
    return call(setup.handler, { action: 'create', name: 'Sysco', anyway: true })
      .then((r) => assert.strictEqual(r.status, 200, r.body.error));
  }))

  .then(() => check('a name that is not a name is refused', () => {
    reset();
    return call(setup.handler, { action: 'create', name: ' ' })
      .then((r) => assert.strictEqual(r.status, 400));
  }))

  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });

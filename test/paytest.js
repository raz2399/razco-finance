// Writing one check against the bills he picked.
//
// This is the path that turns a tick-list into money leaving the
// account, and it had no test at all. What it must get right:
//
//   - one check pays one vendor, never two
//   - the invoices he picked are the ones that get marked paid, and
//     nothing else is touched
//   - a partly paid invoice ends up recorded as paid in full, not as
//     paid only the part that was still outstanding
//   - a number he types that is already spent is refused, because two
//     checks carrying one number is how the bank pays the wrong one
//   - no number at all is allowed, and that check goes to Print checks
//     to get its number from the pad actually in the printer

const assert = require('assert');
const path = require('path');
const Module = require('module');
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

let DB;
function reset() {
  DB = {
    vendors: [
      { store_id: 'store1', vendor_id: 'v-ok', name: 'OK PRODUCE' },
      { store_id: 'store1', vendor_id: 'v-mj', name: 'M & J Seafood' },
    ],
    invoices: [
      { store_id: 'store1', invoice_id: 'i1', vendor_id: 'v-ok', invoice_number: '100',
        invoice_date: '2026-10-28', total_amount: 500, amount_paid: 0,
        balance_due: 500, status: 'approved' },
      { store_id: 'store1', invoice_id: 'i2', vendor_id: 'v-ok', invoice_number: '101',
        invoice_date: '2026-10-30', total_amount: 900, amount_paid: 0,
        balance_due: 900, status: 'approved' },
      // Part of this one was settled outside the system.
      { store_id: 'store1', invoice_id: 'i3', vendor_id: 'v-ok', invoice_number: '102',
        invoice_date: '2026-11-01', total_amount: 1000, amount_paid: 600,
        balance_due: 400, status: 'partially_paid' },
      { store_id: 'store1', invoice_id: 'i-other', vendor_id: 'v-mj', invoice_number: '900',
        invoice_date: '2026-11-01', total_amount: 300, amount_paid: 0,
        balance_due: 300, status: 'approved' },
    ],
    payments: [
      { store_id: 'store1', payment_id: 'p-old', method: 'check', check_number: 9947,
        amount: 1086.19, payment_date: '2026-11-03', status: 'outstanding' },
    ],
    payment_allocations: [],
    bank_transactions: [
      { store_id: 'store1', bank_txn_id: 'b1', check_number: 9888,
        amount: -3447.64, posted_date: '2026-11-03' },
    ],
    bank_accounts: [{ store_id: 'store1', account_id: 'acct-1' }],
    exceptions: [],
  };
}

function query(table) {
  let rows = (DB[table] || []).slice();
  let mode = null;
  let payload = null;
  const api = {
    select() { return api; },
    insert(p) { mode = 'insert'; payload = p; return api; },
    update(p) { mode = 'update'; payload = p; return api; },
    eq(c, v) { rows = rows.filter((r) => String(r[c]) === String(v)); return api; },
    neq(c, v) { rows = rows.filter((r) => String(r[c]) !== String(v)); return api; },
    lt(c, v) { rows = rows.filter((r) => Number(r[c]) < Number(v)); return api; },
    gte(c, v) { rows = rows.filter((r) => String(r[c]) >= String(v)); return api; },
    in(c, vs) { rows = rows.filter((r) => vs.indexOf(r[c]) > -1); return api; },
    is(c, v) { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
    order() { return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    range(a, b) { rows = rows.slice(a, b + 1); return api; },
    maybeSingle() { return finish(true); },
    single() { return finish(true); },
    then(res) { return finish(false).then(res); },
  };
  function finish(one) {
    if (mode === 'insert') {
      const list = Array.isArray(payload) ? payload : [payload];
      const made = list.map((r, i) => Object.assign({
        payment_id: 'new-' + (DB.payments.length + i + 1),
      }, r));
      DB[table].push.apply(DB[table], made);
      return Promise.resolve({ data: one ? made[0] : made, error: null });
    }
    if (mode === 'update') {
      rows.forEach((r) => {
        Object.assign(r, payload);
        if (r.total_amount !== undefined && r.amount_paid !== undefined) {
          r.balance_due = Math.round((r.total_amount - r.amount_paid) * 100) / 100;
        }
      });
      return Promise.resolve({ data: rows, error: null });
    }
    return Promise.resolve({ data: one ? (rows[0] || null) : rows, error: null });
  }
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_PAY';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_PAY = {
  id: 'MOCK_PAY', filename: 'MOCK_PAY', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

// The schema lookup goes over HTTP in the real thing.
global.fetch = () => Promise.resolve({
  json: () => Promise.resolve({
    definitions: {
      payments: {
        required: [],
        properties: {
          store_id: {}, account_id: {}, vendor_id: {}, method: {}, check_number: {},
          amount: {}, payment_date: {}, memo: {}, status: {}, issued_at: {},
        },
      },
      invoices: {
        required: [],
        properties: {
          store_id: {}, vendor_id: {}, invoice_number: {}, invoice_date: {},
          total_amount: {}, amount_paid: {}, status: {},
        },
      },
    },
  }),
});

const { handler } = require(path.join(ROOT, 'functions', 'invoices.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch((e) => { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); });
}

const pay = (body) => handler({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer t' },
  queryStringParameters: {},
  body: JSON.stringify(Object.assign({ store_id: 'store1', action: 'pay' }, body)),
}).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

const inv = (id) => DB.invoices.filter((i) => i.invoice_id === id)[0];
const checks = () => DB.payments.filter((p) => p.payment_id.indexOf('new-') === 0);

console.log('\nthe check pays exactly what he ticked');

Promise.resolve()
  .then(() => check('one invoice', () => {
    reset();
    return pay({ invoice_ids: ['i1'], check_number: '9961' }).then((r) => {
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(checks().length, 1);
      assert.strictEqual(Number(checks()[0].amount), 500);
      assert.strictEqual(inv('i1').status, 'paid');
      // And nothing he did not tick.
      assert.strictEqual(inv('i2').status, 'approved');
      assert.strictEqual(Number(inv('i2').amount_paid), 0);
    });
  }))

  .then(() => check('several, added up', () => {
    reset();
    return pay({ invoice_ids: ['i1', 'i2'], check_number: '9961' }).then((r) => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(Number(checks()[0].amount), 1400);
      assert.strictEqual(inv('i1').status, 'paid');
      assert.strictEqual(inv('i2').status, 'paid');
    });
  }))

  .then(() => check('a part-paid bill contributes only what is left of it', () => {
    reset();
    return pay({ invoice_ids: ['i3'], check_number: '9961' }).then((r) => {
      assert.strictEqual(r.status, 200);
      // 400 still owed on a 1000 invoice, 600 of it settled elsewhere.
      assert.strictEqual(Number(checks()[0].amount), 400);
      // But it ends up recorded as paid in full, not as paid 400 --
      // otherwise the books would say a 1000 invoice was settled for 400.
      assert.strictEqual(Number(inv('i3').amount_paid), 1000);
      assert.strictEqual(inv('i3').status, 'paid');
    });
  }))

  .then(() => { console.log('\nwhat it refuses'); })

  .then(() => check('one check never pays two vendors', () => {
    reset();
    return pay({ invoice_ids: ['i1', 'i-other'], check_number: '9961' }).then((r) => {
      assert.strictEqual(r.status, 400);
      assert.ok(/one vendor/i.test(r.body.error), r.body.error);
      assert.strictEqual(checks().length, 0, 'it wrote a check anyway');
    });
  }))

  .then(() => check('nothing ticked, nothing written', () => {
    reset();
    return pay({ invoice_ids: [], check_number: '9961' }).then((r) => {
      assert.strictEqual(r.status, 400);
      assert.strictEqual(checks().length, 0);
    });
  }))

  .then(() => check('a number already on the books is refused', () => {
    // 9947 is a check he wrote by hand that the bank already cleared.
    // Writing a second one carrying it is how the bank pays the wrong one.
    reset();
    return pay({ invoice_ids: ['i1'], check_number: '9947' }).then((r) => {
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
      assert.ok(r.body.duplicate_of);
      assert.strictEqual(checks().length, 0, 'it reused a spent number');
    });
  }))

  .then(() => check('a number the bank has already seen is refused too', () => {
    // 9888 never went into the books, but it went through the account.
    // The books not knowing about it does not make the number free.
    reset();
    return pay({ invoice_ids: ['i1'], check_number: '9888' }).then((r) => {
      assert.strictEqual(r.status, 409, JSON.stringify(r.body));
      assert.strictEqual(checks().length, 0);
    });
  }))

  .then(() => check('but he can force it when he knows better', () => {
    reset();
    return pay({ invoice_ids: ['i1'], check_number: '9947', allow_duplicate: true })
      .then((r) => {
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(checks().length, 1);
      });
  }))

  .then(() => { console.log('\nno number yet'); })

  .then(() => check('a check with no number is allowed', () => {
    // This is the one that goes to Print checks. Demanding a number here
    // meant guessing one before printing, and guessing is how 9960 went
    // into the books as 9986.
    reset();
    return pay({ invoice_ids: ['i1', 'i2'] }).then((r) => {
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(checks().length, 1);
      assert.strictEqual(checks()[0].check_number, null);
      assert.strictEqual(Number(checks()[0].amount), 1400);
      assert.strictEqual(inv('i1').status, 'paid');
    });
  }))

  .then(() => check('and it waits where Print checks looks', () => {
    // Print checks offers anything with method check, no number, and a
    // status that is not finished with.
    const c = checks()[0];
    assert.strictEqual(c.method, 'check');
    assert.strictEqual(c.check_number, null);
    assert.ok(['outstanding', 'draft', 'approved', 'pending_approval'].indexOf(c.status) > -1,
      'status was ' + c.status + ', which Print checks would not show');
  }))

  .then(() => check('it says who it is to, so the paper can be written', () => {
    reset();
    return pay({ invoice_ids: ['i1'] }).then(() => {
      assert.strictEqual(checks()[0].vendor_id, 'v-ok');
      assert.ok(/OK PRODUCE/.test(checks()[0].memo), checks()[0].memo);
      // And which bills it covers, so the stub means something.
      assert.ok(/100/.test(checks()[0].memo), checks()[0].memo);
    });
  }))

  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });

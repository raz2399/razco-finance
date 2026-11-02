// The bank feed becoming the book of record.
//
// This is the suite that matters most in the repo, because the thing it
// guards is the thing he said must never happen: money appearing on the
// screen that was not real. A settlement pass writes payments nobody
// typed. Get it wrong and it invents money quietly, in a direction that
// looks like good news.
//
// So the cases here are mostly about refusing:
//
//   - nothing before the cutover, ever
//   - never the same bank line twice, however many times it is run
//   - never payroll, taxes, card settlements or software bills
//   - never a second payment for a check he already wrote down
//   - never a silent correction when the bank and the books disagree

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { readLine, spread, vendorFor, isNotPayable, statusAfter } =
  require(path.join(ROOT, 'functions', 'lib', 'settle.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch((e) => { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); });
}

const VENDORS = [
  { vendor_id: 'v-ok', name: 'OK PRODUCE' },
  { vendor_id: 'v-mj', name: 'M & J Seafood Co., Inc.' },
  { vendor_id: 'v-bimbo', name: 'BIMBO BAKERIES' },
  { vendor_id: 'v-marquez', name: 'Marquez Brothers International, Inc. - Fresno' },
  { vendor_id: 'v-short', name: 'AB' },
];

const line = (over) => Object.assign({
  bank_txn_id: 'b1', posted_date: '2026-10-30', description: 'SOMETHING',
  amount: -100, check_number: null, is_pending: false, vendor_id: null,
}, over);

console.log('\nwhat the system refuses to call a bill');

Promise.resolve()
  .then(() => check('payroll is an expense, never accounts payable', () => {
    const r = readLine(line({ description: 'PAYROLL RAZCO LINDSAY IN CCD', amount: -6789.53 }), VENDORS);
    assert.strictEqual(r.kind, 'skip', JSON.stringify(r));
  }))

  .then(() => check('so is the tax draft', () => {
    assert.strictEqual(
      readLine(line({ description: 'TAXDRAFT ASURE PAYROLL TA CCD', amount: -7398.45 }), VENDORS).kind,
      'skip');
    assert.strictEqual(
      readLine(line({ description: 'CA DEPT TAX FEE CDTFA EPMT ACH ENTRY', amount: -9233 }), VENDORS).kind,
      'skip');
  }))

  .then(() => check('and the software bills', () => {
    ['AWS', 'GOOGLECLOUD 47X8VL LOC: 650', 'FACEBK LSHSADEQS4 LOC:',
     'TWILIO INC LOC: WWW.TWILIO.COCA', 'DIGITALOCEAN.COM'].forEach((d) => {
      assert.strictEqual(readLine(line({ description: d }), VENDORS).kind, 'skip', d);
    });
  }))

  .then(() => check('a card settlement coming in is not a payment going out', () => {
    const r = readLine(line({ description: 'MERCHANT BNKCD DEPOSIT ACH', amount: 14031.14 }), VENDORS);
    assert.strictEqual(r.kind, 'skip');
  }))

  .then(() => check('a pending line is left alone until it is real', () => {
    // It can still change its amount or vanish. Acting on one would mean
    // recording a payment that never happened.
    const r = readLine(line({ description: 'BIMBO BAKERIES BBUSA ACH', amount: -1693.65, is_pending: true }), VENDORS);
    assert.strictEqual(r.kind, 'skip');
    assert.ok(/pending/.test(r.why));
  }))

  .then(() => { console.log('\nwhat it does recognise'); })

  .then(() => check('a cleared check is a payment that happened', () => {
    const r = readLine(line({ description: 'CHECK 9942', amount: -1768.98, check_number: 9942 }), VENDORS);
    assert.strictEqual(r.kind, 'check');
    assert.strictEqual(r.check_number, 9942);
    assert.strictEqual(r.amount, 1768.98);
  }))

  .then(() => check('a vendor taking their own money is a draft', () => {
    const r = readLine(line({ description: 'BBUSA BIMBO BAKERIES WEB RAZ ALI', amount: -900.43 }), VENDORS);
    assert.strictEqual(r.kind, 'vendor');
    assert.strictEqual(r.vendor.vendor_id, 'v-bimbo');
  }))

  .then(() => check('a vendor name survives the bank mangling it', () => {
    const v = vendorFor('M J SEAFOOD CO INC CCD ACH ENTRY MEMO', VENDORS);
    assert.ok(v, 'M & J Seafood was not found');
    assert.strictEqual(v.vendor_id, 'v-mj');
  }))

  .then(() => check('a two-letter vendor never claims a line', () => {
    // A vendor called "AB" would otherwise own every description with
    // those letters in it.
    const v = vendorFor('RANDOM ABSTRACT PAYMENT', VENDORS);
    assert.ok(!v || v.vendor_id !== 'v-short', 'a short name claimed a line');
  }))

  .then(() => check('two possible vendors means no guess at all', () => {
    const both = [
      { vendor_id: 'a', name: 'GOLDEN VALLEY DISTRIBUTION' },
      { vendor_id: 'b', name: 'GOLDEN VALLEY' },
    ];
    assert.strictEqual(vendorFor('GOLDEN VALLEY DISTRIBUTION CCD', both), null,
      'picked one vendor when two matched');
  }))

  .then(() => { console.log('\nwhere the money lands'); })

  .then(() => check('oldest invoice first, to the cent', () => {
    const invs = [
      { invoice_id: 'new', invoice_date: '2026-10-30', total_amount: 500, amount_paid: 0, balance_due: 500 },
      { invoice_id: 'old', invoice_date: '2026-10-28', total_amount: 300, amount_paid: 0, balance_due: 300 },
    ];
    const s = spread(400, invs);
    assert.strictEqual(s.parts[0].invoice_id, 'old');
    assert.strictEqual(s.parts[0].amount, 300);
    assert.strictEqual(s.parts[1].invoice_id, 'new');
    assert.strictEqual(s.parts[1].amount, 100);
    assert.strictEqual(s.left_over, 0);
  }))

  .then(() => check('it never puts more on an invoice than the invoice is for', () => {
    const invs = [{ invoice_id: 'i', invoice_date: '2026-10-28', total_amount: 100, amount_paid: 0, balance_due: 100 }];
    const s = spread(250, invs);
    assert.strictEqual(s.parts.length, 1);
    assert.strictEqual(s.parts[0].amount, 100);
    // The rest is a credit on the account, not forced onto an invoice
    // that does not exist yet.
    assert.strictEqual(s.left_over, 150);
  }))

  .then(() => check('a part-paid invoice only takes what is left of it', () => {
    const invs = [{ invoice_id: 'i', invoice_date: '2026-10-28', total_amount: 1000, amount_paid: 600, balance_due: 400 }];
    const s = spread(1000, invs);
    assert.strictEqual(s.parts[0].amount, 400);
    assert.strictEqual(s.parts[0].paid_after, 1000);
    assert.strictEqual(s.parts[0].settles, true);
    assert.strictEqual(s.left_over, 600);
  }))

  .then(() => check('pennies do not drift', () => {
    const invs = [
      { invoice_id: 'a', invoice_date: '2026-10-28', total_amount: 33.33, amount_paid: 0, balance_due: 33.33 },
      { invoice_id: 'b', invoice_date: '2026-10-29', total_amount: 33.33, amount_paid: 0, balance_due: 33.33 },
      { invoice_id: 'c', invoice_date: '2026-10-30', total_amount: 33.34, amount_paid: 0, balance_due: 33.34 },
    ];
    const s = spread(100, invs);
    const total = s.parts.reduce((t, p) => t + p.amount, 0);
    assert.strictEqual(Math.round(total * 100) / 100, 100);
    assert.strictEqual(s.left_over, 0);
  }))

  .then(() => check('an invoice is only paid when it is actually paid', () => {
    assert.strictEqual(statusAfter(100, 100), 'paid');
    assert.strictEqual(statusAfter(100, 99.99), 'partially_paid');
    assert.strictEqual(statusAfter(100, 0), 'approved');
  }))

  .then(() => { console.log('\nthe two that would put wrong money on his screen'); })

  .then(() => runTheRealThing())

  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });

// ---------------------------------------------------------------------
// The whole pass, against a database that behaves like his.

function runTheRealThing() {
  const Module = require('module');

  let DB;
  function reset() {
    DB = {
      store_settings: [{ store_id: 'store1', cutover_date: '2026-10-28', autosettle: true }],
      bank_accounts: [{ store_id: 'store1', account_id: 'acct-1' }],
      vendors: [
        { store_id: 'store1', vendor_id: 'v-ok', name: 'OK PRODUCE' },
        { store_id: 'store1', vendor_id: 'v-bimbo', name: 'BIMBO BAKERIES' },
      ],
      invoices: [
        { store_id: 'store1', invoice_id: 'inv-old', vendor_id: 'v-ok', invoice_number: '100',
          invoice_date: '2026-10-28', total_amount: 500, amount_paid: 0, balance_due: 500, status: 'approved' },
        { store_id: 'store1', invoice_id: 'inv-new', vendor_id: 'v-ok', invoice_number: '101',
          invoice_date: '2026-10-30', total_amount: 900, amount_paid: 0, balance_due: 900, status: 'approved' },
      ],
      payments: [
        // One he typed himself, for a check the bank is about to confirm.
        { store_id: 'store1', payment_id: 'pay-typed', method: 'check', check_number: 9954,
          amount: 8371.81, payment_date: '2026-11-02', status: 'outstanding',
          vendor_id: 'v-ok', bank_txn_id: null, created_from_bank: false },
      ],
      payment_allocations: [],
      bank_transactions: [
        // BEFORE the cutover. Already inside the opening balances.
        { store_id: 'store1', bank_txn_id: 'b-old', posted_date: '2026-09-15',
          description: 'CHECK 9000', amount: -5000, check_number: 9000, is_pending: false },
        // A check nobody wrote down.
        { store_id: 'store1', bank_txn_id: 'b-check', posted_date: '2026-10-30',
          description: 'CHECK 9942', amount: -1200, check_number: 9942, is_pending: false },
        // The check he DID write down.
        { store_id: 'store1', bank_txn_id: 'b-typed', posted_date: '2026-11-02',
          description: 'CHECK 9954', amount: -8371.81, check_number: 9954, is_pending: false },
        // A vendor draft.
        { store_id: 'store1', bank_txn_id: 'b-draft', posted_date: '2026-10-31',
          description: 'BBUSA BIMBO BAKERIES WEB RAZ ALI', amount: -900.43, is_pending: false },
        // Payroll.
        { store_id: 'store1', bank_txn_id: 'b-pay', posted_date: '2026-10-30',
          description: 'PAYROLL RAZCO LINDSAY IN CCD', amount: -6789.53, is_pending: false },
        // Money in.
        { store_id: 'store1', bank_txn_id: 'b-in', posted_date: '2026-10-30',
          description: 'DEPOSIT MERCHANT BNKCD CCD', amount: 14674.30, is_pending: false },
      ],
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
      delete() { mode = 'delete'; return api; },
      eq(c, v) { rows = rows.filter((r) => r[c] === v); return api; },
      gte(c, v) { rows = rows.filter((r) => String(r[c]) >= String(v)); return api; },
      in(c, vs) { rows = rows.filter((r) => vs.indexOf(r[c]) > -1); return api; },
      order() { return api; },
      limit(n) { rows = rows.slice(0, n); return api; },
      range(a, b) { rows = rows.slice(a, b + 1); return api; },
      maybeSingle() { return finish(true); },
      single() { return finish(true); },
      then(res) { return finish(false).then(res); },
    };
    function finish(one) {
      if (mode === 'insert') {
        const r = Object.assign({}, payload);
        if (table === 'payments') {
          // The unique index on bank_txn_id, enforced here too.
          if (r.bank_txn_id && DB.payments.some((x) => x.bank_txn_id === r.bank_txn_id)) {
            return Promise.resolve({ data: null, error: { message: 'duplicate key value' } });
          }
          r.payment_id = 'auto-' + (DB.payments.length + 1);
        }
        DB[table].push(r);
        return Promise.resolve({ data: one ? r : [r], error: null });
      }
      if (mode === 'update') {
        rows.forEach((r) => Object.assign(r, payload));
        return Promise.resolve({ data: rows, error: null });
      }
      if (mode === 'delete') {
        DB[table] = (DB[table] || []).filter((r) => rows.indexOf(r) === -1);
        return Promise.resolve({ data: rows, error: null });
      }
      return Promise.resolve({ data: one ? (rows[0] || null) : rows, error: null });
    }
    return api;
  }

  const sb = { from: query };
  const { plan, apply, undo } = require(path.join(ROOT, 'functions', 'lib', 'settlerun.js'));

  const owed = () => DB.invoices.reduce((s, i) => s + Number(i.balance_due || 0), 0);
  const recompute = () => DB.invoices.forEach((i) => {
    i.balance_due = Math.round((Number(i.total_amount) - Number(i.amount_paid)) * 100) / 100;
  });

  return Promise.resolve()
    .then(() => check('nothing before the cutover is ever touched', () => {
      reset();
      return plan(sb, 'store1').then((p) => {
        const ids = p.created.map((c) => c.bank_txn_id).concat(p.skipped.map((s) => s.bank_txn_id));
        assert.ok(ids.indexOf('b-old') === -1,
          'a pre-cutover check was considered -- that is $4.69m of history waiting to be counted twice');
      });
    }))

    .then(() => check('a check nobody wrote down becomes a payment', () => {
      reset();
      return plan(sb, 'store1').then((p) => {
        const made = p.created.filter((c) => c.check_number === 9942)[0];
        assert.ok(made, 'the cleared check did not become a payment');
        assert.strictEqual(made.amount, 1200);
        assert.strictEqual(made.payment_date, '2026-10-30');
      });
    }))

    .then(() => check('a check he DID write down is confirmed, not duplicated', () => {
      reset();
      return plan(sb, 'store1').then((p) => {
        assert.strictEqual(p.created.filter((c) => c.check_number === 9954).length, 0,
          'it created a second payment for a check already in the books');
        const l = p.linked.filter((x) => x.check_number === 9954)[0];
        assert.ok(l, 'his own check was not confirmed by the bank');
        assert.strictEqual(l.payment_id, 'pay-typed');
      });
    }))

    .then(() => check('a check that cleared for the wrong amount is raised, not smoothed over', () => {
      reset();
      DB.bank_transactions.filter((t) => t.bank_txn_id === 'b-typed')[0].amount = -9999;
      return plan(sb, 'store1').then((p) => {
        assert.strictEqual(p.disagreements.length, 1, 'the difference was swallowed');
        assert.strictEqual(p.disagreements[0].written_for, 8371.81);
        assert.strictEqual(p.disagreements[0].cleared_for, 9999);
        assert.strictEqual(p.created.filter((c) => c.check_number === 9954).length, 0);
      });
    }))

    .then(() => check('the draft lands on the oldest invoice first', () => {
      reset();
      return plan(sb, 'store1').then(() => plan(sb, 'store1')).then((p) => {
        const draft = p.created.filter((c) => c.bank_txn_id === 'b-draft')[0];
        assert.ok(draft);
        // Bimbo has no open invoices here, so it is a credit, not a
        // forced allocation onto somebody else's bill.
        assert.strictEqual(draft.allocations.length, 0);
        assert.strictEqual(draft.left_over, 900.43);
      });
    }))

    .then(() => check('money actually comes off what he owes', () => {
      reset();
      DB.bank_transactions.push({
        store_id: 'store1', bank_txn_id: 'b-ok', posted_date: '2026-10-31',
        description: 'OK PRODUCE CCD ACH ENTRY', amount: -700, is_pending: false,
      });
      const before = owed();
      return plan(sb, 'store1')
        .then((p) => apply(sb, 'store1', p))
        .then(() => {
          recompute();
          assert.strictEqual(before, 1400);
          assert.strictEqual(owed(), 700, 'the $700 never came off the invoices');
          const old = DB.invoices.filter((i) => i.invoice_id === 'inv-old')[0];
          assert.strictEqual(old.status, 'paid', 'the oldest invoice was not settled');
          assert.strictEqual(Number(old.amount_paid), 500);
          const nw = DB.invoices.filter((i) => i.invoice_id === 'inv-new')[0];
          assert.strictEqual(Number(nw.amount_paid), 200);
          assert.strictEqual(nw.status, 'partially_paid');
        });
    }))

    .then(() => check('RUNNING IT TWICE CHANGES NOTHING', () => {
      // The one that would quietly double his payments and take money
      // off bills that were never paid.
      reset();
      DB.bank_transactions.push({
        store_id: 'store1', bank_txn_id: 'b-ok', posted_date: '2026-10-31',
        description: 'OK PRODUCE CCD ACH ENTRY', amount: -700, is_pending: false,
      });
      return plan(sb, 'store1')
        .then((p) => apply(sb, 'store1', p))
        .then(() => { recompute(); })
        .then(() => {
          const paymentsAfterOne = DB.payments.length;
          const owedAfterOne = owed();
          return plan(sb, 'store1')
            .then((p2) => {
              assert.strictEqual(p2.created.length, 0,
                'a second pass wanted to create ' + p2.created.length + ' more payments');
              return apply(sb, 'store1', p2);
            })
            .then(() => {
              recompute();
              assert.strictEqual(DB.payments.length, paymentsAfterOne, 'payments were duplicated');
              assert.strictEqual(owed(), owedAfterOne, 'what he owes moved on a second run');
            });
        });
    }))

    .then(() => check('and a third run, for good measure', () => {
      const n = DB.payments.length;
      const o = owed();
      return plan(sb, 'store1').then((p) => apply(sb, 'store1', p)).then(() => {
        recompute();
        assert.strictEqual(DB.payments.length, n);
        assert.strictEqual(owed(), o);
      });
    }))

    .then(() => { console.log('\nall of it can be taken back'); })

    .then(() => check('undo puts the books back exactly as they were', () => {
      reset();
      DB.bank_transactions.push({
        store_id: 'store1', bank_txn_id: 'b-ok', posted_date: '2026-10-31',
        description: 'OK PRODUCE CCD ACH ENTRY', amount: -700, is_pending: false,
      });
      const before = { owed: owed(), payments: DB.payments.length };
      return plan(sb, 'store1')
        .then((p) => apply(sb, 'store1', p))
        .then(() => { recompute(); })
        .then(() => undo(sb, 'store1'))
        .then(() => {
          recompute();
          assert.strictEqual(owed(), before.owed, 'undo did not restore what he owes');
          assert.strictEqual(DB.payments.length, before.payments,
            'undo left payments behind, or removed one he typed');
          assert.ok(DB.payments.some((p) => p.payment_id === 'pay-typed'),
            'undo deleted a payment he entered by hand');
        });
    }));
}

// Tests lib/matcher.js on its own, without a database.
//
// The cases here are the ones where being wrong costs real money, and
// each is written as a question about Raz's books rather than about the
// code:
//
//   - can one check pay two bills?            (claiming)
//   - does a check that cleared for the wrong
//     amount get noticed, or smoothed over?   (the fraud case)
//   - is "close enough" ever a match?         (it must not be)
//   - does a line the system merely RECOGNISES
//     get counted as matched?                 (it must not be)
//
// The last one is the subtle one. Payroll is recognisable and will never
// have an invoice behind it. If recognised silently counted as matched,
// the headline "98% of your bank is accounted for" would be a lie told
// with real arithmetic.

const assert = require('assert');
const path = require('path');
const { index, matchOne, matchAll, learned, sameMoney } =
  require(path.join(__dirname, '..', 'functions', 'lib', 'matcher.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ---- fixtures -------------------------------------------------------
const VENDOR_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VENDOR_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const payments = [
  { payment_id: 'p-9887', check_number: 9887, amount: 24272.80,
    vendor_id: VENDOR_A, status: 'outstanding' },
  { payment_id: 'p-9888', check_number: 9888, amount: 1000.00,
    vendor_id: VENDOR_A, status: 'outstanding' },
  { payment_id: 'p-void', check_number: 9999, amount: 500.00,
    vendor_id: VENDOR_A, status: 'void' },
];

const invoices = [
  { invoice_id: 'i-1', vendor_id: VENDOR_A, invoice_number: '4471',
    balance_due: 708.19, status: 'approved' },
  { invoice_id: 'i-2', vendor_id: VENDOR_B, invoice_number: '8800',
    balance_due: 2500.00, status: 'approved' },
  { invoice_id: 'i-3', vendor_id: VENDOR_B, invoice_number: '8801',
    balance_due: 2500.00, status: 'approved' },
  { invoice_id: 'i-paid', vendor_id: VENDOR_A, invoice_number: '0001',
    balance_due: 0, status: 'paid' },
];

const ctx0 = index(payments, invoices);

const classifyStub = (desc, amt) => {
  const t = String(desc || '').toUpperCase();
  if (/PAYROLL/.test(t)) {
    return { code: 'payroll', label: 'Payroll', kind: 'expense',
             why: 'Wages.', confident: true };
  }
  if (/TONYS FINE/.test(t)) {
    return { code: 'vendor_draft', label: 'Vendor draft', kind: 'settles',
             vendor_id: VENDOR_A, why: 'Tony takes it.', confident: true };
  }
  // Truncated on purpose: the real statement says "VALLEY WIDE BEVE",
  // not "BEVERAGE". A stub that reads better than the bank does would
  // test a world Raz does not live in.
  if (/BEVE/.test(t)) {
    return { code: 'vendor_draft', label: 'Vendor draft', kind: 'settles',
             vendor_id: VENDOR_B, why: 'Draft.', confident: true };
  }
  return { code: 'unknown', label: 'not named', kind: 'unknown',
           why: 'nothing matches', confident: false };
};

const base = (over) => Object.assign({
  bank_txn_id: 't-' + Math.random().toString(16).slice(2),
  description: 'CHECK 9887', check_number: null, amount: -100,
}, over);

// ---- the cases ------------------------------------------------------
console.log('\nmatcher');

check('check number and exact amount is a match', () => {
  const d = matchOne(
    base({ check_number: 9887, amount: -24272.80, description: 'CHECK 9887' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('CHECK 9887', -24272.80) });
  assert.strictEqual(d.status, 'matched');
  assert.strictEqual(d.matched_type, 'payment');
  assert.strictEqual(d.matched_id, 'p-9887');
  assert.strictEqual(d.exception, null, 'a clean match raises nothing');
});

check('a check that cleared for the WRONG amount is matched AND flagged', () => {
  const d = matchOne(
    base({ check_number: 9888, amount: -8000.00, description: 'CHECK 9888' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('CHECK 9888', -8000) });
  assert.strictEqual(d.status, 'matched');
  assert.strictEqual(d.matched_id, 'p-9888');
  assert.ok(d.exception, 'must raise an exception');
  assert.strictEqual(d.exception.what, 'check_amount_differs');
  assert.strictEqual(d.exception.severity, 'critical');
  // Both figures have to be in front of him, not just the difference.
  assert.ok(d.exception.detail.indexOf('1000.00') > -1, 'says what was written');
  assert.ok(d.exception.detail.indexOf('8000.00') > -1, 'says what cleared');
});

check('a voided check is not available to match', () => {
  const d = matchOne(
    base({ check_number: 9999, amount: -500, description: 'CHECK 9999' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('CHECK 9999', -500) });
  assert.notStrictEqual(d.status, 'matched');
  assert.strictEqual(d.exception.what, 'check_not_in_books');
});

check('a check with nothing in the books is called out, not dropped', () => {
  const d = matchOne(
    base({ check_number: 6701, amount: -1193.51, description: 'CHECK 6701' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('CHECK 6701', -1193.51) });
  assert.strictEqual(d.status, 'unmatched');
  assert.strictEqual(d.exception.what, 'check_not_in_books');
  assert.strictEqual(d.kind, 'settles');
});

check('a vendor draft for the exact open balance matches the invoice', () => {
  const d = matchOne(
    base({ amount: -708.19, description: 'COLLECTION TONYS FINE F2767 CCD' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('COLLECTION TONYS FINE F2767 CCD', -708.19) });
  assert.strictEqual(d.status, 'matched');
  assert.strictEqual(d.matched_type, 'invoice');
  assert.strictEqual(d.matched_id, 'i-1');
});

check('two open invoices for the same amount is NOT matched - it asks', () => {
  const d = matchOne(
    base({ amount: -2500.00, description: 'FINTECHEFT VALLEY WIDE BEVE CCD' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('FINTECHEFT VALLEY WIDE BEVE CCD', -2500) });
  assert.notStrictEqual(d.status, 'matched');
  assert.strictEqual(d.exception.what, 'ambiguous_invoice');
});

check('close is not a match - one cent off matches nothing', () => {
  assert.strictEqual(sameMoney(708.19, 708.20), false);
  const d = matchOne(
    base({ amount: -708.20, description: 'COLLECTION TONYS FINE F2767 CCD' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('COLLECTION TONYS FINE F2767 CCD', -708.20) });
  assert.notStrictEqual(d.status, 'matched');
});

check('payroll is RECOGNISED, never matched', () => {
  const d = matchOne(
    base({ amount: -4580.12, description: 'PAYROLL RAZCO LINDSAY IN CCD' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('PAYROLL RAZCO LINDSAY IN CCD', -4580.12) });
  assert.strictEqual(d.status, 'recognized');
  assert.strictEqual(d.matched_id, null, 'recognised must not claim a row');
  assert.strictEqual(d.kind, 'expense');
});

check('an unknown line stays unknown and is not guessed into income', () => {
  const d = matchOne(
    base({ amount: 40000, description: 'MISCELLANEOUS CREDIT' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classifyStub('MISCELLANEOUS CREDIT', 40000) });
  assert.strictEqual(d.status, 'unmatched');
  assert.strictEqual(d.kind, 'unknown');
  assert.notStrictEqual(d.kind, 'income');
});

check('a rule Raz taught outranks the built-in guess', () => {
  const rules = [{ pattern: 'CHICAGO TITLE', kind: 'expense',
                   code: 'escrow', label: 'Escrow', category_id: 7 }];
  const d = matchOne(
    base({ amount: -115000, description: 'CHICAGO TITLE COMPANY' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: rules,
      classified: classifyStub('CHICAGO TITLE COMPANY', -115000) });
  assert.strictEqual(d.status, 'recognized');
  assert.strictEqual(d.kind, 'expense');
  assert.strictEqual(d.category_id, 7);
});

check('the longest taught pattern wins', () => {
  const rules = [
    { pattern: 'BIMBO', kind: 'expense', code: 'broad', category_id: 1 },
    { pattern: 'BIMBO BAKERIES', kind: 'settles', code: 'narrow', category_id: 2 },
  ];
  const hit = learned('BBUSA BIMBO BAKERIES WEB RAZ *ALI', rules);
  assert.strictEqual(hit.code, 'narrow');
});

check('ONE check cannot clear TWO bank lines', () => {
  // The same $1,000 debit twice. Only one of them is check 9888.
  const txns = [
    base({ bank_txn_id: 'x1', check_number: 9888, amount: -1000,
           description: 'CHECK 9888' }),
    base({ bank_txn_id: 'x2', check_number: 9888, amount: -1000,
           description: 'CHECK 9888' }),
  ];
  const r = matchAll(txns, {
    byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
    classify: classifyStub,
  });
  const matched = r.decisions.filter((d) => d.matched_id === 'p-9888');
  assert.strictEqual(matched.length, 1,
    'p-9888 was claimed ' + matched.length + ' times');
  assert.strictEqual(r.tally.matched, 1);
});

check('the big one goes first when two lines compete', () => {
  const txns = [
    base({ bank_txn_id: 's', amount: -708.19,
           description: 'COLLECTION TONYS FINE F2767 CCD' }),
    base({ bank_txn_id: 'L', amount: -24272.80, check_number: 9887,
           description: 'CHECK 9887' }),
  ];
  const r = matchAll(txns, {
    byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
    classify: classifyStub,
  });
  assert.strictEqual(r.decisions[0].bank_txn_id, 'L', 'largest first');
  assert.strictEqual(r.tally.matched, 2);
});

check('the tally counts matched and recognised separately', () => {
  const txns = [
    base({ bank_txn_id: 'a', check_number: 9887, amount: -24272.80,
           description: 'CHECK 9887' }),
    base({ bank_txn_id: 'b', amount: -4580.12,
           description: 'PAYROLL RAZCO LINDSAY IN CCD' }),
    base({ bank_txn_id: 'c', amount: 40000,
           description: 'MISCELLANEOUS CREDIT' }),
  ];
  const r = matchAll(txns, {
    byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
    classify: classifyStub,
  });
  assert.strictEqual(r.tally.matched, 1);
  assert.strictEqual(r.tally.recognized, 1);
  assert.strictEqual(r.tally.unmatched, 1);
  assert.strictEqual(r.tally.unknown_value_in, 40000);
});

check('uncashed checks are counted and totalled for him', () => {
  const txns = [
    base({ bank_txn_id: 'u1', check_number: 6701, amount: -1193.51,
           description: 'CHECK 6701' }),
    base({ bank_txn_id: 'u2', check_number: 6698, amount: -1464.99,
           description: 'CHECK 6698' }),
  ];
  const r = matchAll(txns, {
    byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
    classify: classifyStub,
  });
  assert.strictEqual(r.tally.checks_not_in_books, 2);
  assert.strictEqual(r.tally.checks_not_in_books_value, 2658.50);
});

check('a paid invoice is never re-matched', () => {
  const idx = index([], invoices);
  const open = idx.byVendor[VENDOR_A] || [];
  assert.ok(open.every((i) => i.invoice_id !== 'i-paid'),
    'a paid invoice must not be a candidate');
});


check('a check that came back unpaid is raised, not banked as income', () => {
  const classified = { code: 'returned_item', label: 'Check came back',
                       kind: 'settles', why: 'came back', confident: true };
  const d = matchOne(
    base({ check_number: 9761, amount: 637.35,
           description: 'RETURN SIGNATURE IRREGULAR W/O 09-18-2026 9761' }),
    { byCheck: ctx0.byCheck, byVendor: ctx0.byVendor, rules: [],
      classified: classified });
  assert.strictEqual(d.kind, 'settles', 'must not read as income');
  assert.ok(d.exception, 'must be raised');
  assert.strictEqual(d.exception.what, 'check_returned_unpaid');
  assert.ok(d.exception.detail.indexOf('has not been paid') > -1);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

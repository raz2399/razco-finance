// Checking a wholesaler's monthly statement against his own books.
//
// This is the job that catches what nothing else can: a delivery never
// entered, a check they have not credited, an invoice billed twice. By
// hand it means two lists and a ruler, so it never gets done, and the
// first anyone hears of a problem is the vendor putting the store on
// hold.
//
// The thing to get right is that it only ever REPORTS. A disagreement
// between two records is settled by a phone call, not by an edit, and a
// system that quietly moved his books to match a photograph would be
// manufacturing agreement rather than finding it. So these tests are
// about the four answers being right, and about the failures that would
// invent a disagreement that is not there.

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { compare, summarise, refKey, numKey } =
  require(path.join(ROOT, 'functions', 'lib', 'vstatement.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const theirs = (n, amount, over) => Object.assign({
  invoice_number: n, invoice_date: '2026-10-20', amount: amount, kind: 'invoice',
}, over || {});

const ours = (n, balance, over) => Object.assign({
  invoice_id: 'i-' + n, invoice_number: n, invoice_date: '2026-10-20',
  total_amount: balance, balance_due: balance, status: 'approved',
}, over || {});

// ---------------------------------------------------------------------
// The four answers
// ---------------------------------------------------------------------

check('lines that agree are reported as agreed', () => {
  const r = compare([theirs('4471', 1200)], [ours('4471', 1200)]);
  assert.strictEqual(r.counts.agreed, 1);
  assert.strictEqual(r.counts.amount_differs, 0);
  assert.strictEqual(r.counts.theirs_only, 0);
  assert.strictEqual(r.counts.ours_only, 0);
});

check('a figure that does not match is flagged, with which way', () => {
  // The commonest real finding: a credit one side applied and the other
  // did not.
  const r = compare([theirs('4471', 1200)], [ours('4471', 1020)]);
  assert.strictEqual(r.counts.amount_differs, 1);
  const d = r.amount_differs[0];
  assert.strictEqual(d.theirs, 1200);
  assert.strictEqual(d.ours, 1020);
  assert.strictEqual(d.gap, 180);
  assert.strictEqual(d.they_want_more, true);
});

check('and the other way round too', () => {
  const r = compare([theirs('4471', 900)], [ours('4471', 1000)]);
  assert.strictEqual(r.amount_differs[0].they_want_more, false);
  assert.strictEqual(r.amount_differs[0].gap, -100);
});

check('a bill only they have is theirs_only', () => {
  // Either a delivery nobody entered, or something he never had. The
  // two look identical from here, which is exactly why he must look.
  const r = compare([theirs('9999', 430)], []);
  assert.strictEqual(r.counts.theirs_only, 1);
  assert.strictEqual(r.theirs_only[0].amount, 430);
});

check('a bill only he has is ours_only', () => {
  const r = compare([], [ours('4471', 1200)]);
  assert.strictEqual(r.counts.ours_only, 1);
  assert.strictEqual(r.ours_only[0].invoice_id, 'i-4471');
});

check('every line lands in exactly one answer', () => {
  const r = compare(
    [theirs('1', 100), theirs('2', 200), theirs('X', 50)],
    [ours('1', 100), ours('2', 250), ours('Y', 75)]);
  const total = r.counts.agreed + r.counts.amount_differs + r.counts.theirs_only;
  assert.strictEqual(total, 3, 'their three lines');
  assert.strictEqual(r.counts.ours_only, 1, 'his unmatched one');
});

// ---------------------------------------------------------------------
// Matching references the way they are really printed
// ---------------------------------------------------------------------

check('punctuation and padding do not stop a match', () => {
  // INV-004471 on their statement, 4471 in his books.
  const r = compare([theirs('INV-004471', 1200)], [ours('4471', 1200)]);
  assert.strictEqual(r.counts.agreed, 1);
});

check('spaces and case do not stop a match', () => {
  const r = compare([theirs(' inv 4471 ', 1200)], [ours('INV4471', 1200)]);
  assert.strictEqual(r.counts.agreed, 1);
});

check('an all-zero reference does not collapse to nothing', () => {
  assert.strictEqual(refKey('000'), '000');
  assert.strictEqual(refKey('0004471'), '4471');
  assert.strictEqual(refKey('---'), null);
  assert.strictEqual(refKey(null), null);
});

check('a short number is not enough to pair on', () => {
  // The danger in matching on the number inside a reference: every
  // reference ending in "1" would pair with every other. A false pair
  // does not merely miss a problem, it reports a disagreement between
  // two invoices that have nothing to do with each other.
  assert.strictEqual(numKey('A-1'), null);
  assert.strictEqual(numKey('PO 123'), null);
  assert.strictEqual(numKey('INV-004471'), '#4471');
  assert.strictEqual(numKey('NO DIGITS'), null);

  const r = compare([theirs('CM-1', 50)], [ours('REF-1', 50)]);
  assert.strictEqual(r.counts.agreed, 0, 'one digit must not pair these');
  assert.strictEqual(r.counts.theirs_only, 1);
});

check('an exact reference always beats the loose one', () => {
  // Both of his could pair with their "4471" on the bare number; the
  // one that wrote it the same way must win.
  const r = compare([theirs('4471', 500)],
    [ours('XY-004471', 500, { invoice_id: 'i-loose' }),
     ours('4471', 500, { invoice_id: 'i-exact' })]);
  assert.strictEqual(r.counts.agreed, 1);
  assert.strictEqual(r.agreed[0].invoice_id, 'i-exact');
});

check('a line with no reference is never matched by amount alone', () => {
  // Pairing two lines because the money happens to agree is how a
  // statement check invents a reconciliation that never happened.
  const r = compare([theirs(null, 1200)], [ours('4471', 1200)]);
  assert.strictEqual(r.counts.theirs_only, 1);
  assert.strictEqual(r.counts.ours_only, 1);
  assert.strictEqual(r.counts.agreed, 0);
});

check('a repeated reference pairs on the closest amount', () => {
  // Two bills under one number. Pairing in the order they arrive would
  // mismatch both and report two disagreements instead of none.
  const r = compare(
    [theirs('4471', 1200), theirs('4471', 300)],
    [ours('4471', 300, { invoice_id: 'i-small' }),
     ours('4471', 1200, { invoice_id: 'i-big' })]);
  assert.strictEqual(r.counts.agreed, 2, JSON.stringify(r.counts));
  assert.strictEqual(r.counts.amount_differs, 0);
});

check('one invoice cannot be matched twice', () => {
  const r = compare([theirs('4471', 1200), theirs('4471', 1200)],
    [ours('4471', 1200)]);
  assert.strictEqual(r.counts.agreed, 1);
  assert.strictEqual(r.counts.theirs_only, 1, 'the second has nothing left to pair with');
});

// ---------------------------------------------------------------------
// Lines on a statement that are not bills
// ---------------------------------------------------------------------

check('a payment they list is not matched against an invoice', () => {
  // It is their side of something already settled. Matching it by
  // reference would pair it with the very invoice it paid and report a
  // disagreement that is not one.
  const r = compare(
    [theirs('4471', 1200), theirs('4471', -1200, { kind: 'payment' })],
    [ours('4471', 1200)]);
  assert.strictEqual(r.counts.agreed, 1);
  assert.strictEqual(r.counts.amount_differs, 0);
  assert.strictEqual(r.counts.theirs_only, 1);
  assert.ok(/payment/.test(r.theirs_only[0].note || ''), r.theirs_only[0].note);
});

check('a credit they list is reported, not matched', () => {
  const r = compare([theirs('CM-12', -180, { kind: 'credit' })], []);
  assert.strictEqual(r.counts.theirs_only, 1);
  assert.ok(/credit/.test(r.theirs_only[0].note || ''));
});

// ---------------------------------------------------------------------
// The totals
// ---------------------------------------------------------------------

check('both totals and the gap between them are reported', () => {
  const r = compare([theirs('1', 100), theirs('2', 200)],
    [ours('1', 100), ours('2', 150)]);
  assert.strictEqual(r.their_total, 300);
  assert.strictEqual(r.our_total, 250);
  assert.strictEqual(r.gap, 50);
});

check('a statement that disagrees with itself is called out', () => {
  // Their lines come to $300 and their own total says $450. Nothing
  // worked out from those lines can be trusted until that is explained.
  const r = compare([theirs('1', 100), theirs('2', 200)],
    [ours('1', 100), ours('2', 200)]);
  const s = summarise(r, 450);
  assert.ok(s.warning, 'should warn');
  assert.ok(/not read|total is wrong/.test(s.warning), s.warning);
});

check('a statement that agrees with itself raises nothing', () => {
  const r = compare([theirs('1', 100)], [ours('1', 100)]);
  assert.strictEqual(summarise(r, 100).warning, null);
});

check('all clear says so plainly', () => {
  const r = compare([theirs('1', 100)], [ours('1', 100)]);
  assert.ok(/matches your books/.test(summarise(r, null).says));
});

check('a cent of rounding is not a disagreement', () => {
  const r = compare([theirs('1', 100.00)], [ours('1', 100.004)]);
  assert.strictEqual(r.counts.agreed, 1);
});

check('nothing at all on either side does not throw', () => {
  const r = compare([], []);
  assert.strictEqual(r.their_total, 0);
  assert.strictEqual(r.our_total, 0);
  assert.ok(/matches/.test(summarise(r, null).says));
});

check('it compares the balance still owed, not the face of the bill', () => {
  // He has part-paid: the bill was $1,000, $400 is left, and a statement
  // showing $400 agrees. Comparing against the total would report a
  // $600 disagreement on a perfectly correct statement.
  const r = compare([theirs('4471', 400)],
    [ours('4471', 400, { total_amount: 1000, balance_due: 400, status: 'partially_paid' })]);
  assert.strictEqual(r.counts.agreed, 1);
});

console.log('\nvstatement: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);

// The highlighter.
//
// He asked for cleared items in yellow. The danger in a highlighter is
// that it is reassuring: a marked line reads as finished, so anything
// marked that is not finished hides work instead of showing it. These
// cases are mostly about what must NOT come back marked clean:
//
//   - a pending line, which the bank can still take back
//   - a check that cleared against nobody
//   - money out that the books have never heard of
//
// And about the suggestion the one-press apply acts on, which must be
// unambiguous or absent. A wrong vendor on a check is invisible until a
// statement arrives months later, and by then two vendors are wrong.

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { soleInvoiceFor, readRow, tally } =
  require(path.join(ROOT, 'functions', 'lib', 'mark.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const VN = { 'v-ok': 'OK PRODUCE', 'v-cs': 'C&S GROCERY', 'v-mj': 'M & J SEAFOOD' };

const line = (over) => Object.assign({
  bank_txn_id: 'b1',
  posted_date: '2026-11-04',
  description: 'CHECK 9960',
  amount: -1200,
  check_number: null,
  is_pending: false,
}, over || {});

const inv = (over) => Object.assign({
  invoice_id: 'i1',
  vendor_id: 'v-ok',
  invoice_number: 'A-1',
  invoice_date: '2026-10-30',
  due_date: '2026-11-15',
  total_amount: 1200,
  amount_paid: 0,
  balance_due: 1200,
  status: 'approved',
}, over || {});

const pay = (over) => Object.assign({
  payment_id: 'p1',
  bank_txn_id: 'b1',
  vendor_id: 'v-ok',
  amount: 1200,
  check_number: '9960',
  settles_ap: true,
}, over || {});

// ---------------------------------------------------------------------
// What gets marked
// ---------------------------------------------------------------------

check('a cleared payment against a vendor is marked settled', () => {
  const r = readRow(line(), pay(), VN, []);
  assert.strictEqual(r.state, 'settled');
  assert.strictEqual(r.vendor, 'OK PRODUCE');
  assert.strictEqual(r.needs, null);
});

check('a cost that was never a bill is settled, not a problem', () => {
  // Payroll, card settlement, utilities. Real money, nothing owed.
  const r = readRow(line({ description: 'PAYROLL' }),
    pay({ settles_ap: false, vendor_id: null }), VN, []);
  assert.strictEqual(r.state, 'settled');
  assert.strictEqual(r.is_cost, true);
  assert.strictEqual(r.needs, null);
});

check('money in is its own state, never a problem', () => {
  const r = readRow(line({ amount: 18500, description: 'DEPOSIT' }), null, VN, []);
  assert.strictEqual(r.state, 'in');
  assert.strictEqual(r.needs, null);
});

check('a deposit already on the books is still just money in', () => {
  const r = readRow(line({ amount: 18500 }), pay({ vendor_id: null }), VN, []);
  assert.strictEqual(r.state, 'in');
});

// ---------------------------------------------------------------------
// What must never be marked clean
// ---------------------------------------------------------------------

check('pending is never marked, however complete the books look', () => {
  // The bank can still take a pending line back. Marking it says the
  // reconciling is done when it cannot be.
  const r = readRow(line({ is_pending: true }), pay(), VN, []);
  assert.strictEqual(r.state, 'pending');
});

check('pending stays pending even when it needs a name', () => {
  const r = readRow(line({ is_pending: true }), pay({ vendor_id: null }), VN, []);
  assert.strictEqual(r.state, 'pending');
  assert.strictEqual(r.needs, 'name');
});

check('pending money in is pending, not in', () => {
  const r = readRow(line({ amount: 500, is_pending: true }), null, VN, []);
  assert.strictEqual(r.state, 'pending');
});

check('money out the books never heard of needs him', () => {
  const r = readRow(line(), null, VN, []);
  assert.strictEqual(r.state, 'needs');
  assert.strictEqual(r.needs, 'not_in_books');
});

check('a check that cleared against nobody needs a name', () => {
  // This is the one that used to have the system asking him to pay a
  // vendor the bank had already paid.
  const r = readRow(line(), pay({ vendor_id: null }), VN, []);
  assert.strictEqual(r.state, 'needs');
  assert.strictEqual(r.needs, 'name');
  assert.strictEqual(r.vendor, null);
});

check('a nameless cost is not a nameless check', () => {
  // settles_ap false says outright it was never a bill. No name wanted.
  const r = readRow(line(), pay({ vendor_id: null, settles_ap: false }), VN, []);
  assert.strictEqual(r.state, 'settled');
  assert.strictEqual(r.needs, null);
});

check('the check number is carried from the payment when the bank omits it', () => {
  const r = readRow(line({ check_number: null }), pay({ check_number: '9960' }), VN, []);
  assert.strictEqual(r.check_number, '9960');
});

// ---------------------------------------------------------------------
// The suggestion: unambiguous or nothing
// ---------------------------------------------------------------------

check('one open invoice for the exact amount is suggested', () => {
  const r = readRow(line(), pay({ vendor_id: null }), VN, [inv()]);
  assert.ok(r.suggest, 'expected a suggestion');
  assert.strictEqual(r.suggest.vendor_id, 'v-ok');
  assert.strictEqual(r.suggest.invoice_id, 'i1');
  assert.strictEqual(r.suggest.vendor, 'OK PRODUCE');
});

check('TWO invoices for the amount suggests nothing', () => {
  // The property that protects money. Guessing between two vendors is
  // wrong twice over and silent for months.
  const two = [inv(), inv({ invoice_id: 'i2', vendor_id: 'v-cs', invoice_number: 'B-9' })];
  const r = readRow(line(), pay({ vendor_id: null }), VN, two);
  assert.strictEqual(r.suggest, null);
  assert.strictEqual(r.needs, 'name');
});

check('two invoices for the amount from the SAME vendor still suggests nothing', () => {
  // The vendor would be right, the invoice would be a coin flip, and
  // one real bill would stay open while another closed wrongly.
  const two = [inv(), inv({ invoice_id: 'i2', invoice_number: 'A-2' })];
  const r = readRow(line(), pay({ vendor_id: null }), VN, two);
  assert.strictEqual(r.suggest, null);
});

check('a cent out is not an exact amount', () => {
  const r = readRow(line({ amount: -1200.01 }), pay({ vendor_id: null }), VN, [inv()]);
  assert.strictEqual(r.suggest, null);
});

check('the balance is what must match, not the face of the invoice', () => {
  // Part-paid already: $1,200 invoice with $900 left. A $1,200 check is
  // not this bill.
  const part = inv({ total_amount: 1200, amount_paid: 300, balance_due: 900 });
  assert.strictEqual(readRow(line({ amount: -1200 }), pay({ vendor_id: null }), VN, [part]).suggest, null);
  assert.ok(readRow(line({ amount: -900 }), pay({ vendor_id: null }), VN, [part]).suggest);
});

check('an invoice from another season is not a match on amount alone', () => {
  const old = inv({ invoice_date: '2026-04-01', due_date: '2026-04-20' });
  const r = readRow(line(), pay({ vendor_id: null }), VN, [old]);
  assert.strictEqual(r.suggest, null);
});

check('an invoice with no dates at all is still allowed to match', () => {
  const nd = inv({ invoice_date: null, due_date: null });
  assert.ok(readRow(line(), pay({ vendor_id: null }), VN, [nd]).suggest);
});

check('a settled line is never given a suggestion', () => {
  const r = readRow(line(), pay(), VN, [inv()]);
  assert.strictEqual(r.suggest, null);
});

check('soleInvoiceFor refuses a zero or missing amount', () => {
  assert.strictEqual(soleInvoiceFor(0, '2026-11-04', [inv({ balance_due: 0 })]), null);
  assert.strictEqual(soleInvoiceFor(null, '2026-11-04', [inv()]), null);
});

check('soleInvoiceFor takes the amount either sign', () => {
  // Bank rows are negative, invoices are positive. Both must find it.
  assert.ok(soleInvoiceFor(-1200, '2026-11-04', [inv()]));
  assert.ok(soleInvoiceFor(1200, '2026-11-04', [inv()]));
});

// ---------------------------------------------------------------------
// The cutover floor
//
// These are the cases that the first version of this got wrong against
// his real statement: 92 lines and $371,787 of money out, all of it
// before the cutover, all of it correctly netted inside the QuickBooks
// opening balances, and all of it marked as needing him. A statement
// view that cries wolf about the opening balances is worse than none.
// ---------------------------------------------------------------------

const CUT = '2026-10-28';

check('money out before the cutover is closed, not a problem', () => {
  const r = readRow(line({ posted_date: '2026-10-27' }), null, VN, [], CUT);
  assert.strictEqual(r.state, 'closed');
  assert.strictEqual(r.needs, null);
  assert.strictEqual(r.before_cutover, true);
});

check('the cutover day itself is in scope', () => {
  // The floor is "nothing BEFORE", so the day it starts counts.
  const r = readRow(line({ posted_date: CUT }), null, VN, [], CUT);
  assert.strictEqual(r.state, 'needs');
});

check('money in before the cutover is closed too', () => {
  const r = readRow(line({ posted_date: '2026-10-20', amount: 22000 }), null, VN, [], CUT);
  assert.strictEqual(r.state, 'closed');
});

check('a pending line before the cutover is still closed', () => {
  // Pending beats settled, but nothing beats the floor: a line that old
  // is inside the opening balances whatever the bank calls it today.
  const r = readRow(line({ posted_date: '2026-10-20', is_pending: true }), null, VN, [], CUT);
  assert.strictEqual(r.state, 'closed');
});

check('nothing before the cutover is ever suggested for naming', () => {
  // The press must not reach back. Settlement is forbidden to, and a
  // naming here would take money off a bill twice: once inside the
  // opening balance and once again now.
  const r = readRow(line({ posted_date: '2026-10-20' }),
    pay({ vendor_id: null }), VN, [inv({ invoice_date: '2026-10-18', due_date: '2026-10-25' })], CUT);
  assert.strictEqual(r.suggest, null);
  assert.strictEqual(r.state, 'closed');
});

check('with no cutover set, nothing is closed', () => {
  // A missing cutover must not quietly close the whole statement. The
  // other screens refuse to settle without one; this one just marks
  // honestly and lets the rest of the system say so.
  const r = readRow(line({ posted_date: '2020-01-01' }), null, VN, [], null);
  assert.strictEqual(r.state, 'needs');
  assert.strictEqual(r.before_cutover, false);
});

// ---------------------------------------------------------------------
// The tally under the page
// ---------------------------------------------------------------------

check('the tally counts every line exactly once', () => {
  const rows = [
    readRow(line({ bank_txn_id: 'a' }), pay(), VN, []),
    readRow(line({ bank_txn_id: 'b' }), null, VN, []),
    readRow(line({ bank_txn_id: 'c', is_pending: true }), null, VN, []),
    readRow(line({ bank_txn_id: 'd', amount: 900 }), null, VN, []),
  ];
  const c = tally(rows);
  assert.strictEqual(c.settled + c.needs + c.pending + c['in'] + c.closed, rows.length);
  assert.strictEqual(c.settled, 1);
  assert.strictEqual(c.needs, 1);
  assert.strictEqual(c.pending, 1);
  assert.strictEqual(c.in, 1);
});

check('can_name counts only what one press could actually do', () => {
  const rows = [
    readRow(line({ bank_txn_id: 'a' }), pay({ vendor_id: null }), VN, [inv()]),
    // Same suggestion, but pending: the press must not touch it.
    readRow(line({ bank_txn_id: 'b', is_pending: true }),
      pay({ payment_id: 'p2', vendor_id: null }), VN, [inv()]),
    // Needs a name, nothing to suggest.
    readRow(line({ bank_txn_id: 'c' }), pay({ payment_id: 'p3', vendor_id: null }), VN, []),
  ];
  assert.strictEqual(tally(rows).can_name, 1);
});

console.log('\nmark: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);

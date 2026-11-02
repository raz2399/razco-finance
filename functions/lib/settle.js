// The bank is the book of record for money that moved.
//
// ---------------------------------------------------------------------
// What was wrong, and why patching it would not have helped
//
// Razi-Nova recorded what he OWED and almost nothing of what he PAID.
// Since the switchover $56,327 left his bank across twenty lines, and
// twelve payments existed in the books. Over the whole history, 1,049
// checks cleared the bank and eight checks existed here -- not one of
// them matching. So accounts payable only ever grew, and the screen
// said he was $196,113 under water when he was not.
//
// The matcher was not broken. It ties bank lines to payments, and it
// does that well. It had nothing to tie them to, because a payment only
// existed if he stopped and typed it in. That is how QuickBooks works:
// key every check, then reconcile it by hand later.
//
// So the fix is not more matching. It is this: a check that cleared the
// bank IS a payment that happened. The bank already knows the date, the
// amount and the number. Waiting to be told a second time is the bug.
//
// ---------------------------------------------------------------------
// The four rules that stop this inventing money
//
// 1. NOTHING BEFORE THE CUTOVER.
//    The opening balances carried over from QuickBooks on 28 October are
//    net figures -- every check that cleared before that date is already
//    deducted inside them. Letting those 1,049 historical checks create
//    payments would settle the same bills twice and take $4.69m off the
//    books that was never there. The cutover date is a hard floor.
//
// 2. ONE PAYMENT PER BANK LINE, FOR EVER.
//    Every payment created here carries the id of the line it came from,
//    behind a unique index. Run this a hundred times and the hundredth
//    run creates nothing. Idempotence is not a nicety here: a settlement
//    pass that double-ran would silently double his payments.
//
// 3. ONLY WHAT IS PLAINLY A VENDOR PAYMENT.
//    Payroll, sales tax, AWS, Facebook, card settlements and transfers
//    are expenses, not accounts payable. They are left alone. A debit
//    becomes a payment only when it is a check, or when it belongs to a
//    vendor on his list on evidence that cannot mean two things.
//
// 4. NEVER OVERWRITE WHAT HE TYPED.
//    If a payment already exists for that check number, this links the
//    two and marks it cleared. It does not create a second one, and it
//    does not change his figure to the bank's. Where the two disagree
//    that is raised, not smoothed over -- a check that cleared for a
//    different amount than it was written for is either a mistake or
//    somebody altering a check.
//
// ---------------------------------------------------------------------
// How a payment finds its invoices
//
// Oldest open invoice first, for that vendor, until the money runs out.
// That is how a vendor applies a check unless told otherwise, and it is
// what makes a statement agree. A payment bigger than everything open
// leaves the remainder sitting as a credit on the account rather than
// forcing it onto an invoice that does not exist yet.
//
// Nothing here is permanent: everything this writes is marked as its
// own, so the whole pass can be listed and undone without disturbing a
// single row he entered by hand.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const up = (s) => String(s == null ? '' : s).toUpperCase();

// Descriptions that are never accounts payable, however they are worded.
// Each one is a thing that leaves the bank for a reason that has no
// invoice behind it.
const NOT_PAYABLE = [
  'PAYROLL', 'TAXDRAFT', 'ASURE', 'CDTFA', 'DEPT TAX', 'IRS', 'EFTPS',
  'FRANCHISE TAX', 'EDD', 'MERCHANT BNKCD', 'DEPOSIT', 'TRANSFER',
  'OVERDRAFT', 'SERVICE CHARGE', 'ANALYSIS', 'INTEREST', 'ATM',
  'AWS', 'GOOGLECLOUD', 'GOOGLE CLOUD', 'DIGITALOCEAN', 'TWILIO',
  'FACEBK', 'FACEBOOK', 'ADOBE', 'MICROSOFT', 'INTUIT', 'NETLIFY',
  'LOAN', 'INSURANCE PREMIUM', 'RENT',
];

function isNotPayable(description) {
  const d = up(description);
  for (let i = 0; i < NOT_PAYABLE.length; i++) {
    if (d.indexOf(NOT_PAYABLE[i]) > -1) return NOT_PAYABLE[i];
  }
  return null;
}

// Vendor names squashed to letters and digits, so "M & J Seafood Co.,
// Inc." is found inside "M J SEAFOOD CO CCD ACH ENTRY".
const squash = (s) => up(s).replace(/[^A-Z0-9]/g, '');

/**
 * Which vendor a bank line belongs to, or null.
 *
 * The name on a statement is rarely the name on the invoice. His own
 * data: the bank writes "BBUSA BIMBO BAKERIES" and the vendor list says
 * "Bimbo Bakires USA"; the bank writes "ROLLING FRITO-LA", cut off mid
 * word, and the list says "FRITO LAY"; the bank writes "COLLECTION TONYS
 * FINE F2767" and the list says "TONY'S FINE FOODS". Exact matching
 * finds none of those.
 *
 * So a vendor matches when the description carries its whole squashed
 * name OR a long enough front of it -- which is what a statement
 * actually prints. The same rule the classifier already uses, so a line
 * cannot be read one way for naming and another way for paying.
 *
 * Where this deliberately differs: the classifier picks the longest
 * match and moves on. Here two different vendors matching means NO
 * match. He has three vendors whose names start "C&S", and a bank line
 * reading "C&S WHOLESALE GR" is genuinely any of them. Guessing would
 * put one vendor's money against another vendor's bills, and that error
 * is invisible until a statement arrives months later.
 */
function headOf(squashed) {
  return squashed.slice(0, Math.max(8, Math.floor(squashed.length * 0.6)));
}

function vendorFor(description, vendors) {
  const d = squash(description);
  if (!d) return null;

  const hits = {};
  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    const names = [v.name].concat(v.aliases || []);
    for (let j = 0; j < names.length; j++) {
      const n = squash(names[j]);
      // A short name is hit by accident inside a bank line far too
      // easily. "AB" would own every description containing those
      // letters.
      if (n.length < 6) continue;
      if (d.indexOf(n) > -1 || d.indexOf(headOf(n)) > -1) {
        hits[v.vendor_id] = v;
        break;
      }
    }
  }

  const ids = Object.keys(hits);
  if (ids.length !== 1) return null;
  return hits[ids[0]];
}

/**
 * What a bank line means for accounts payable.
 *
 * Returns one of:
 *   {kind:'check', check_number, amount}   a check cleared
 *   {kind:'vendor', vendor, amount}        a vendor took their money
 *   {kind:'skip', why}                     not accounts payable
 */
function readLine(txn, vendors) {
  const amount = money(txn.amount);

  // Money coming in is never a payment to a vendor.
  if (amount >= 0) return { kind: 'skip', why: 'money came in' };

  // A pending line can still change its amount or vanish altogether.
  // Acting on one would mean creating a payment that never happened.
  if (txn.is_pending) return { kind: 'skip', why: 'still pending at the bank' };

  const out = Math.abs(amount);
  if (!(out > 0)) return { kind: 'skip', why: 'no amount' };

  if (txn.check_number) {
    return { kind: 'check', check_number: Number(txn.check_number), amount: out };
  }

  const no = isNotPayable(txn.description);
  if (no) return { kind: 'skip', why: 'not a vendor bill (' + no + ')' };

  const v = vendorFor(txn.description, vendors);
  if (!v) return { kind: 'skip', why: 'no vendor could be told from the description' };

  return { kind: 'vendor', vendor: v, amount: out };
}

/**
 * How a payment spreads across open invoices: oldest first, to the cent,
 * stopping when the money runs out.
 *
 * Pure, so the hard part can be tested without a database anywhere near
 * it. The caller writes what this returns.
 */
function spread(amount, invoices) {
  let left = money(amount);
  const parts = [];

  const open = invoices.slice().sort((a, b) => {
    const da = String(a.invoice_date || '');
    const db = String(b.invoice_date || '');
    if (da !== db) return da < db ? -1 : 1;
    return String(a.invoice_id) < String(b.invoice_id) ? -1 : 1;
  });

  for (let i = 0; i < open.length && left > 0; i++) {
    const inv = open[i];
    const due = money(inv.balance_due);
    if (!(due > 0)) continue;
    const take = money(Math.min(due, left));
    if (!(take > 0)) continue;
    parts.push({
      invoice_id: inv.invoice_id,
      amount: take,
      // What the invoice becomes once this lands.
      paid_after: money(money(inv.amount_paid) + take),
      settles: take >= due,
    });
    left = money(left - take);
  }

  return { parts: parts, left_over: money(left) };
}

/**
 * The status an invoice takes once a payment has landed on it.
 * Named here rather than inline so there is one answer, not three.
 */
function statusAfter(total, paidAfter) {
  if (money(paidAfter) >= money(total)) return 'paid';
  if (money(paidAfter) > 0) return 'partially_paid';
  return 'approved';
}

module.exports = {
  money,
  squash,
  isNotPayable,
  vendorFor,
  readLine,
  spread,
  statusAfter,
  NOT_PAYABLE,
};

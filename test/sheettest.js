// Tests the vendor-sheet reader against the shapes a grocery back office
// actually produces.
//
// The failures that would matter most, and are tested for by name:
//   - "Due Date" read as the date, so every line lands fifteen days late
//   - "Open Balance" read as the amount, so a paid bill imports as owed
//   - QuickBooks' "Total Sysco" rows imported as transactions, doubling AP
//   - a line it cannot read dropped quietly, so the total looks right and
//     is short by one invoice

const path = require('path');
const { readVendorSheet } = require(
  path.join(__dirname, '..', 'functions', 'lib', 'sheet.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else {
    fail++;
    console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) +
                '\n       expected ' + JSON.stringify(b));
  }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

// ---- QuickBooks: Transaction List by Vendor --------------------------
console.log('QuickBooks Transaction List by Vendor');
{
  const csv = [
    'Razco Foods Supermarket',
    'Transaction List by Vendor',
    'October 1 - 28, 2026',
    '',
    'Type,Date,Num,Name,Memo,Account,Split,Amount',
    'Bill,10/05/2026,9001,Sysco,Weekly grocery,Accounts Payable,-SPLIT-,"1,245.80"',
    'Bill,10/12/2026,9015,Sysco,Weekly grocery,Accounts Payable,-SPLIT-,"2,100.00"',
    'Bill Pmt -Check,10/19/2026,9500,Sysco,,Checking,Accounts Payable,"-1,245.80"',
    'Total Sysco,,,,,,,"2,100.00"',
    'Bill,10/08/2026,500,Pan Dulce Bakery,Bread,Accounts Payable,-SPLIT-,800.00',
    'Total Pan Dulce Bakery,,,,,,,800.00',
    'TOTAL,,,,,,,"2,900.00"',
  ].join('\n');

  const r = readVendorSheet(csv);
  check('read it', r.ok, true);
  check('recognised the shape', r.shape, 'transaction list');
  check('three bills and a payment', r.lines.length, 4);
  check('the bills', r.summary.invoices, 3);
  check('the payment', r.summary.payments, 1);
  check('nothing it could not read', r.summary.unreadable, 0);

  // The one that would double his AP.
  check('the three total lines were skipped', r.summary.skipped, 3);
  checkTrue('and said to be totals',
    r.skipped.every((s) => s.why === 'a total line'),
    JSON.stringify(r.skipped));

  const pay = r.lines.filter((l) => l.kind === 'payment')[0];
  check('the payment is a payment', pay.kind, 'payment');
  check('at its face value, not negative', pay.amount, 1245.80);
  check('with the check number', pay.number, '9500');

  const bill = r.lines.filter((l) => l.number === '9001')[0];
  check('the bill date is the bill date', bill.date, '2026-10-05');
  check('for the right money', bill.amount, 1245.80);
  check('carrying the vendor name', bill.vendor_name, 'Sysco');
  check('and the memo', bill.memo, 'Weekly grocery');
  check('nothing claims it is paid', bill.already_paid, false);

  // A vendor name with a comma in it has to survive.
  const r2 = readVendorSheet([
    'Type,Date,Num,Name,Amount',
    'Bill,10/05/2026,77,"M & J Seafood Co., Inc.",412.90',
  ].join('\n'));
  check('a comma inside a quoted vendor name', r2.lines[0].vendor_name,
    'M & J Seafood Co., Inc.');
  check('and the amount after it is still right', r2.lines[0].amount, 412.90);
}

// ---- QuickBooks: A/P Aging Detail -----------------------------------
console.log('\nA/P Aging Detail, where Open Balance says what is left');
{
  const csv = [
    'Date,Transaction Type,Num,Vendor,Due Date,Amount,Open Balance',
    '10/05/2026,Bill,9001,Sysco,10/20/2026,"1,245.80",0.00',
    '10/12/2026,Bill,9015,Sysco,10/27/2026,"2,100.00","2,100.00"',
    '10/14/2026,Bill,9020,Sysco,10/29/2026,500.00,200.00',
  ].join('\n');

  const r = readVendorSheet(csv);
  check('read it', r.ok, true);
  check('three lines', r.lines.length, 3);
  check('it knows there is an open balance column', r.has_open_balance, true);

  // The two traps in this shape, both of which put the wrong number on
  // every single line.
  check('Due Date was NOT read as the date', r.lines[0].date, '2026-10-05');
  check('and the due date went where it belongs', r.lines[0].due_date, '2026-10-20');
  check('Open Balance was NOT read as the amount', r.lines[0].amount, 1245.80);

  check('nothing left on it means the sheet says it is paid',
    r.lines[0].already_paid, true);
  check('and a full balance does not', r.lines[1].already_paid, false);
  check('nor does a part payment', r.lines[2].already_paid, false);
  check('with what is left carried through', r.lines[2].open_balance, 200);
  check('one of the three already paid', r.summary.already_paid, 1);
}

// ---- A statement the vendor e-mailed ---------------------------------
console.log('\nA statement with no type column');
{
  const csv = [
    'Date,Invoice #,Amount,Due Date',
    '10/01/2026,500,800.00,10/16/2026',
    '10/08/2026,501,600.00,10/23/2026',
    '10/15/2026,502,(250.00),',
  ].join('\n');

  const r = readVendorSheet(csv);
  check('read it', r.ok, true);
  check('called a statement', r.shape, 'statement');
  check('two bills', r.summary.invoices, 2);
  // Accounting parentheses. Read as a positive, this would have been
  // imported as another $250 owed instead of $250 paid.
  check('a figure in brackets is money coming off', r.summary.payments, 1);
  check('at its value', r.lines[2].amount, 250);
  check('and nothing is assumed to be paid', r.summary.already_paid, 0);
}

// ---- Excel, pasted ---------------------------------------------------
console.log('\nPasted out of Excel, so tabs not commas');
{
  const tsv = [
    'Date\tInvoice #\tAmount\tDue Date',
    '10/01/2026\t500\t800.00\t10/16/2026',
    '10/08/2026\t501\t1,600.00\t10/23/2026',
  ].join('\n');

  const r = readVendorSheet(tsv);
  check('read it', r.ok, true);
  check('two lines', r.lines.length, 2);
  check('and the thousands comma inside a tab field survived',
    r.lines[1].amount, 1600);
}

// ---- Dates in every shape -------------------------------------------
console.log('\nDates, however they are written');
{
  const r = readVendorSheet([
    'Date,Num,Amount',
    '2026-10-05,1,10.00',
    '10/5/2026,2,10.00',
    '10-5-26,3,10.00',
    '"Oct 5, 2026",4,10.00',
  ].join('\n'));
  check('all four read', r.lines.length, 4);
  checkTrue('and all four to the same day',
    r.lines.every((l) => l.date === '2026-10-05'),
    r.lines.map((l) => l.date).join(','));
}

// ---- The rows it cannot read ----------------------------------------
console.log('\nWhat it does with a row it cannot read');
{
  const csv = [
    'Date,Num,Amount',
    '10/05/2026,9001,"1,245.80"',
    'sometime last week,9002,"500.00"',
    '10/07/2026,9003,ask Maria',
    ',,',
    '10/08/2026,9004,0.00',
    '10/09/2026,9005,99.99',
  ].join('\n');

  const r = readVendorSheet(csv);
  check('the readable ones are read', r.lines.length, 2);
  check('and the two bad ones are handed back', r.unreadable.length, 2);
  check('by row number, as the file counts them', r.unreadable[0].row, 3);
  check('saying what was wrong', r.unreadable[0].why, 'could not read the date');
  check('and the other one too', r.unreadable[1].why, 'could not read the amount');
  checkTrue('they are not counted as imported',
    r.summary.invoices === 2 && r.summary.invoices_total === 1345.79);
  check('a zero line is skipped, not called an error', r.summary.skipped, 1);
}

// ---- A sheet that is not a ledger at all -----------------------------
console.log('\nA sheet that is not a ledger');
{
  const r = readVendorSheet('name,phone\nSysco,559-555-1212');
  check('refused', r.ok, false);
  checkTrue('and says what is missing',
    /Date heading and an Amount heading/.test(r.error), r.error);
  checkTrue('showing him what it did see', Array.isArray(r.first_rows));

  const empty = readVendorSheet('');
  check('an empty sheet is refused too', empty.ok, false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

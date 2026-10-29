// Tests what each bank line is called.
//
// The failure this exists to catch is not a crash. It is a number on a
// screen that is too big and looks fine. Card settlements, cash deposits
// and ATM reimbursements are the SAME MONEY the register already counted;
// call any of them income and Razco's revenue reads millions over.
//
// Every description below is a real shape taken from a year of Bank of
// the Sierra statements, not an invented one.

const path = require('path');
const { classify, summarise } = require(
  path.join(__dirname, '..', 'functions', 'lib', 'bankrules.js'));

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

console.log('Money that was already counted at the register');
{
  const card = classify('DEPOSIT    MERCHANT BNKCD CCD', 18534.35);
  check('card settlement is named', card.code, 'card_settlement');
  check('and it is NOT income', card.kind, 'transfer');

  const cash = classify('BUSINESS DEPOSIT', 55583.71);
  check('a cash deposit is named', cash.code, 'cash_deposit');
  check('and it is NOT income', cash.kind, 'transfer');

  const atm = classify('DLY SETTLE MVNT - HG21201 CCD', 700);
  check('the ATM reimbursement is named', atm.code, 'atm_reimbursement');
  check('and it is NOT income', atm.kind, 'transfer');
  checkTrue('and it says why, in his words',
    /your own cash/i.test(atm.why), atm.why);
}

console.log('\nThe ATM, which is two different things');
{
  // The cash coming back is his own. The surcharge is earnings. Lump them
  // together and either the revenue is $68k over or the real $879 of
  // earnings disappears.
  const back = classify('DLY SETTLE MVNT - HG21201 CCD', 300);
  const earned = classify('EFTRANSACT PAYMENT ALLIANCE PPD', 86.71);
  check('the cash coming back is a transfer', back.kind, 'transfer');
  check('the surcharge is income', earned.kind, 'income');
  checkTrue('and they are not the same thing', back.code !== earned.code);
}

console.log('\nA year of his real statement, added up');
{
  // The three that would do the damage, at the volumes actually seen.
  const rows = [];
  for (let i = 0; i < 299; i++) rows.push({ description: 'DEPOSIT    MERCHANT BNKCD CCD', amount: 18534.35 });
  for (let i = 0; i < 36; i++) rows.push({ description: 'BUSINESS DEPOSIT', amount: 55583.71 });
  for (let i = 0; i < 167; i++) rows.push({ description: 'DLY SETTLE MVNT - HG21201 CCD', amount: 407.31 });
  for (let i = 0; i < 10; i++) rows.push({ description: 'EFTRANSACT PAYMENT ALLIANCE PPD', amount: 87.91 });
  for (let i = 0; i < 1035; i++) rows.push({ description: 'CHECK # 9897', amount: -4418.07 });
  for (let i = 0; i < 64; i++) rows.push({ description: 'PURCHASE   C&S WHOLESALE GR CCD', amount: -11073.52 });

  const s = summarise(rows);

  // Over seven and a half million dollars that must never reach income.
  checkTrue('seven million of arriving money is kept out of income',
    s.moved_in > 7500000, String(s.moved_in));
  check('and income is only what the register never saw', s.real_income, 879.1);
  checkTrue('checks and drafts settle what is on the books rather than '
          + 'counting as new costs',
    s.settles > 4500000 && s.real_expense === 0,
    'settles=' + s.settles + ' expense=' + s.real_expense);
  check('nothing went unrecognised', s.unknown_count, 0);
}

console.log('\nMoney going out, by what it is');
{
  const cases = [
    ['CHECK # 5101', -4418, 'check', 'settles'],
    ['PURCHASE   C&S WHOLESALE GR CCD', -11073, 'vendor_draft', 'settles'],
    ['ROLLING    ROLLING FRITO-LA CCD', -731, 'vendor_draft', 'settles'],
    ['BBUSA      BIMBO BAKERIES WEB RAZ  *ALI', -669, 'vendor_draft', 'settles'],
    ['FINTECHEFT VALLEY WIDE BEVE CCD', -2708, 'vendor_draft', 'settles'],
    ['MPV AR PMT PEPSI BEVERAGECO WEB', -17770, 'vendor_draft', 'settles'],
    ['ONLINE FEE REYESCOCACOLA CCD', -8117, 'vendor_draft', 'settles'],
    ['PAYROLL    RAZCO LINDSAY IN CCD', -4580, 'payroll', 'expense'],
    ['TAXDRAFT   ASURE PAYROLL TA CCD', -6382, 'payroll', 'expense'],
    ['CDTFA EPMT CA DEPT TAX FEE CCD', -6904, 'tax', 'expense'],
    ['BILL PAYMT SO CAL EDISON CO WEB', -10605, 'utility', 'expense'],
    ['PAID SCGC  SOCALGAS WEB 123', -216, 'utility', 'expense'],
    ['PACERPYRLC THE HARTFORD CCD', -1876, 'insurance', 'expense'],
    ['PAYMENT    MERCURY INS PPD', -253, 'insurance', 'expense'],
    ['QBOOKS ONL INTUIT * CCD', -122.5, 'subscription', 'expense'],
    ['CASH CONC  NAVITAS CREDIT C PPD', -2428, 'lease', 'expense'],
    ['ACCOUNT ANALYSIS CHARGE', -290, 'bank_fee', 'expense'],
    ['ACH TRX    BROWN AND JOSEPH CCD', -2481, 'collections', 'expense'],
  ];
  cases.forEach((c) => {
    const got = classify(c[0], c[1]);
    check(c[0].slice(0, 26).trim(), [got.code, got.kind], [c[2], c[3]]);
  });
}

console.log('\nPaying a credit card is not an expense');
{
  // What was bought on the card is the expense. Count the card payment
  // too and it is charged twice.
  const c = classify('PAYMENT    CITI CARD ONLINE WEB RASMY ALI', -8537);
  check('named', c.code, 'card_payment');
  check('and treated as moving money, not spending it', c.kind, 'transfer');
  checkTrue('and it says why', /twice/i.test(c.why), c.why);
}

console.log('\nThe card processor taking money back');
{
  const c = classify('DEPOSIT    MERCHANT BNKCD CCD', -3631.51);
  check('a chargeback is not a settlement', c.code, 'card_chargeback');
  check('and it is a real cost', c.kind, 'expense');
}

console.log('\nSomething it has never seen');
{
  const inn = classify('ZXQ TRANSFER FROM SOMEWHERE', 4200);
  check('not named', inn.code, 'unknown');
  check('and NOT assumed to be income', inn.kind, 'unknown');
  checkTrue('and says it does not know', inn.confident === false);

  const s = summarise([{ description: 'ZXQ MYSTERY', amount: 4200 }]);
  check('it stays out of income', s.real_income, 0);
  check('and is counted as something he must name', s.unknown_count, 1);
  check('with the figure kept where he can see it', s.unknown_in, 4200);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

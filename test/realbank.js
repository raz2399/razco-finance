// The classifier, against lines copied from Razco's real statement.
//
// Every description below is verbatim from the bank, numbers stripped.
// That matters more than it sounds: invented test data is written in
// full words, and a bank writes "VALLEY WIDE BEVE" and "TONYS FINE F"
// and "SO CAL EDISON CO". Rules that pass on tidy strings and fail on
// the real ones are the whole risk here.
//
// The count beside each line is how many times it appeared in ten
// months, so a rule that breaks shows how much of the year it breaks.
//
// The assertions are about KIND, not about the label. Kind is what
// moves money on a screen; the label is only what it gets called.

const assert = require('assert');
const path = require('path');
const { classify } = require(path.join(__dirname, '..', 'functions', 'lib', 'bankrules.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// description, amount, expected kind, expected code, times seen
const REAL = [
  // ---- the $7.6m that must never be counted as income ----------------
  ['DEPOSIT    MERCHANT BNKCD CCD',              5505455.57, 'transfer', 'card_settlement', 309],
  ['BUSINESS DEPOSIT',                           2001013.59, 'transfer', 'cash_deposit', 36],
  ['DLY SETTLE MVNT - HG CCD',                     68020.00, 'transfer', 'atm_reimbursement', 167],
  ['PAYMENT    CITI CARD ONLINE WEB RASMY ALI',  -179286.02, 'transfer', 'card_payment', 21],

  // ---- real income the register never sees ---------------------------
  ['EFTRANSACT PAYMENT ALLIANCE PPD',                 879.06, 'income', 'atm_surcharge', 10],

  // ---- checks --------------------------------------------------------
  ['CHECK ',                                     -4572702.23, 'settles', 'check', 1035],
  ['CHECK',                                        -74780.00, 'settles', 'check', 31],

  // ---- checks that came back: credits that are NOT income ------------
  ['RETURN DUPLICATE PRESENTMENT W/O 07-31- ',        915.79, 'settles', 'returned_item', 1],
  ['RETURN UNUSABLE IMAGE W/O 06-16-',                637.35, 'settles', 'returned_item', 1],
  ['SIGNATURE MISSING W/O 09-09- ',                   637.35, 'settles', 'returned_item', 1],
  ['RETURN SIGNATURE IRREGULAR W/O 09-18- ',          637.35, 'settles', 'returned_item', 1],

  // ---- vendors drafting the account ----------------------------------
  ['PURCHASE   C&S WHOLESALE GR CCD',             -708705.19, 'settles', 'vendor_draft', 64],
  ['_2   C&S WHOLESALE GR CCD',                   -219574.44, 'settles', 'vendor_draft', 9],
  ['COLLECTION TONYS FINE F CCD',                 -358587.30, 'settles', 'vendor_draft', 44],
  ['ROLLING    ROLLING FRITO-LA CCD',             -120713.77, 'settles', 'vendor_draft', 165],
  ['BBUSA      BIMBO BAKERIES WEB RAZ  *ALI',      -95738.09, 'settles', 'vendor_draft', 143],
  ['FINTECHEFT VALLEY WIDE BEVE CCD',             -108338.75, 'settles', 'vendor_draft', 40],
  ['FINTECHEFT BUENO BEVERAGE C CCD',              -57989.14, 'settles', 'vendor_draft', 45],
  ['FINTECHEFT DONAGHY SALES, L CCD',              -26816.09, 'settles', 'vendor_draft', 25],
  ['MPV AR PMT PEPSI BEVERAGECO WEB RAZCO LINDSAY *INC', -124393.01, 'settles', 'vendor_draft', 7],
  ['ONLINE FEE REYESCOCACOLA CCD',                 -73056.63, 'settles', 'vendor_draft', 9],
  ['AR PAYMENT SUPERVALU INC. CCD',                -17418.63, 'settles', 'vendor_draft', 2],
  ['INVOICE    B H DISTRIBUTO CCD',                -18707.43, 'settles', 'vendor_draft', 7],

  // ---- running the place ---------------------------------------------
  ['PAYROLL    RAZCO LINDSAY IN CCD',              -96184.65, 'expense', 'payroll', 21],
  // Reads as payroll AND as tax. Named explicitly so it cannot land
  // wherever the rule order happens to put it.
  ['TAXDRAFT   ASURE PAYROLL TA CCD',             -146801.86, 'expense', 'payroll_tax', 23],
  ['WEB PMTS   FINGERCHECK WEB RAZCO LINDSAY',      -4458.00, 'expense', 'payroll', 10],
  ['CDTFA EPMT CA DEPT TAX FEE CCD',               -75947.29, 'expense', 'tax', 11],
  ['PAYMENTS   FRANCHISE TAX BO CCD',               -2849.31, 'expense', 'tax', 4],
  ['USATAXPYMT IRS CCD',                             -271.63, 'expense', 'tax', 1],
  ['BILL PAYMT SO CAL EDISON CO WEB RAZCO LINDSAY INC', -95448.98, 'expense', 'utility', 9],
  ['PAID SCGC  SOCALGAS WEB ',                      -1512.08, 'expense', 'utility', 7],
  [' UNWIRED BROADBAN CCD',                         -1335.84, 'expense', 'utility', 8],
  ['DBT CRD  10/01/26  MID-VALLEY DISPOSAL 559-237-CA CARD# ', -737.10, 'expense', 'utility', 1],
  ['BUS INSUR  TRAVELERS TEL',                     -29171.84, 'expense', 'insurance', 1],
  ['PACERPYRLC THE HARTFORD CCD',                   -7507.92, 'expense', 'insurance', 4],
  ['DEBITPMT   SAGESURE INSURAN PPD',              -12917.27, 'expense', 'insurance', 2],
  ['PAYMENT    MERCURY INS PPD',                    -2278.56, 'expense', 'insurance', 9],
  ['DBT CRD  10/24/26  PROGRESSIVE INS 800-776-OH CARD# ', -516.32, 'expense', 'insurance', 1],
  ['CASH CONC  NAVITAS CREDIT C PPD',               -9713.52, 'expense', 'lease', 4],
  ['ACCOUNT ANALYSIS CHARGE',                       -2908.81, 'expense', 'bank_fee', 10],
  ['CHANGE ORDER FEE(S)',                             -20.00, 'expense', 'bank_fee', 1],
  ['ACH TRX    BROWN AND JOSEPH CCD',               -7445.33, 'expense', 'collections', 3],
  ['ACH DEBIT  TCCG, LLC CCD',                     -12908.78, 'expense', 'collections', 4],
  ['QBOOKS ONL INTUIT * CCD',                       -1225.00, 'expense', 'subscription', 10],
  ['ACH        PYE-BARKER FIRE CCD',                 -603.00, 'expense', 'repairs', 10],
  ['NEXOMEDIA  NEXO MEDIA INC CCD',                  -350.00, 'expense', 'advertising', 10],
  ['LICENSERNW DEPT ALCBEVCTL CCD',                  -737.00, 'expense', 'license', 1],

  // ---- the long tail of card swipes ----------------------------------
  ['DBT CRD  09/03/26  AMAZON WEB SERVICES AWS.AMAZON.COWA CARD# ', -191.03, 'expense', 'subscription', 1],
  ['DBT CRD  08/31/26  TWILIO INC WWW.TWILIO.COCA CARD# ',  -43.68, 'expense', 'subscription', 1],
  ['DBT CRD  10/20/26  FACEBK *JKYF4DARS4 650-543-CA CARD# ', -360.00, 'expense', 'advertising', 1],
  ['DBT CRD  10/13/26  CHEVRON  VISALIACA CARD# ',         -151.89, 'expense', 'fuel', 1],
  ['DBT CRD  08/07/26  SHELL OIL  STRATHMORECA CARD# ',    -108.80, 'expense', 'fuel', 1],
  ['POS DEB  06/02/26  THE HOME DEPOT # PORTERVILLECA CARD# ', -261.11, 'expense', 'supplies', 1],
  ['DBT CRD  10/23/26  AMAZON MKTPL*Y20RR4Z53 AMZN.COM/BILLWA CARD# ', -319.38, 'expense', 'supplies', 1],
  ['DBT CRD  08/22/26  4TE*TULARE CO ENV HEALT 559-624-CA CARD# ', -1170.29, 'expense', 'license', 1],
  ['DBT CRD  09/16/26  STATE OF CALIF DMV INT 800-CA CARD# ', -332.00, 'expense', 'license', 1],
  ['DBT CRD  07/18/26  STARBUCKS STORE  LINDSAYCA CARD# ',  -55.30, 'expense', 'debit_card', 1],
  ['POS DEB  10/07/26  WAL-MART #  W HENDERSON AVE PORTERVILLECA   C# ', -106.28, 'expense', 'supplies', 1],

  // ---- the bank's own arithmetic -------------------------------------
  ['DEBIT CORRECTION',                                 -0.18, 'transfer', 'bank_correction', 2],
  ['CREDIT CORRECTION',                                 0.05, 'transfer', 'bank_correction', 1],
];

console.log('\nreal statement lines');

let covered = 0;
let lines = 0;
REAL.forEach((row) => {
  const desc = row[0];
  const amt = row[1];
  const wantKind = row[2];
  const wantCode = row[3];
  const seen = row[4];
  lines += seen;
  check(wantCode + '  <- ' + desc.trim().slice(0, 46), () => {
    const c = classify(desc, amt, []);
    assert.strictEqual(c.kind, wantKind,
      'kind was ' + c.kind + ' (' + c.code + '), wanted ' + wantKind);
    assert.strictEqual(c.code, wantCode, 'code was ' + c.code);
    assert.strictEqual(c.confident, true, 'should be confident');
  });
  covered += seen;
});

// ---- the ones that MUST stay unknown ---------------------------------
// Large, unexplained, and the system has no business inventing a story
// for them. A wrong guess on $115,000 is worse than an honest blank.
console.log('\nlines that must stay unknown');

[
  ['CHICAGO TITLE COMPANY 135 N LOS ROBLES AVENUE PASADENA  EAST WEST BANK', -115000],
  ['MISCELLANEOUS DEBIT', -40000],
  ['WIRE TRANSFER DEBIT', -14224.63],
].forEach((row) => {
  check('unknown  <- ' + row[0].slice(0, 40), () => {
    const c = classify(row[0], row[1], []);
    assert.strictEqual(c.confident, false, 'guessed "' + c.code + '" at $'
      + Math.abs(row[1]).toLocaleString() + '; it should ask instead');
    assert.strictEqual(c.kind, 'unknown');
  });
});

check('money in is never assumed to be income', () => {
  const c = classify('MISCELLANEOUS CREDIT', 40000, []);
  assert.notStrictEqual(c.kind, 'income');
  assert.strictEqual(c.kind, 'unknown');
});

console.log('\n' + covered + ' of 2,660 statement lines covered by these rules');
console.log(pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

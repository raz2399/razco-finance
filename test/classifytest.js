// Every debit lands somewhere.
//
// The failure this exists to stop is the quietest one in the system:
// money leaves the bank and becomes nothing. No payment, no invoice, no
// expense. $63,000 went out of his account in six days and most of it
// reached no figure on any screen -- so the week looked cheaper than it
// was, and bills the bank had already paid still said "Pay now" with a
// button next to them.
//
// Every case below is a real line off his statement.

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { classifyLine, vendorFor, invoiceForAmount, cardMerchant } =
  require(path.join(ROOT, 'functions', 'lib', 'classify.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// His real vendor list, including the spellings that caused the trouble:
// "Bakires" is how the name is actually stored, and the bank writes
// "BAKERIES"; three vendors begin "C&S".
const VENDORS = [
  { vendor_id: 'v-frito', name: 'FRITO LAY' },
  { vendor_id: 'v-bimbo', name: 'Bimbo Bakires USA' },
  { vendor_id: 'v-valley', name: 'VALLEY WIDE BEVERAGE' },
  { vendor_id: 'v-tony', name: "TONY'S FINE FOODS" },
  { vendor_id: 'v-cs1', name: 'C&S' },
  { vendor_id: 'v-cs2', name: 'c&s global foods inc' },
  { vendor_id: 'v-cs3', name: 'C&S GROCERY' },
];

const OPEN = [
  { invoice_id: 'i-frito-1', vendor_id: 'v-frito', invoice_number: '16166932',
    invoice_date: '2026-10-30', due_date: '2026-10-30', total_amount: 377.28,
    amount_paid: 0, balance_due: 377.28 },
  { invoice_id: 'i-frito-2', vendor_id: 'v-frito', invoice_number: '16168621',
    invoice_date: '2026-11-02', due_date: '2026-11-02', total_amount: 278.43,
    amount_paid: 0, balance_due: 278.43 },
  { invoice_id: 'i-bimbo', vendor_id: 'v-bimbo', invoice_number: '64045690006106',
    invoice_date: '2026-11-02', due_date: '2026-11-02', total_amount: 135.00,
    amount_paid: 0, balance_due: 135.00 },
  { invoice_id: 'i-valley', vendor_id: 'v-valley', invoice_number: 'W4755051',
    invoice_date: '2026-11-02', due_date: '2026-11-02', total_amount: 1704.07,
    amount_paid: 0, balance_due: 1704.07 },
];

const CTX = { vendors: VENDORS, aliases: [], openInvoices: OPEN };

const line = (over) => Object.assign({
  bank_txn_id: 'b', posted_date: '2026-11-02', description: '',
  amount: -100, check_number: null, is_pending: false,
}, over);

// ---------------------------------------------------------------------
// Things that are not spending, in his bank's own words
//
// Each of these was found on his real statement, and each was being
// counted as something it is not.
// ---------------------------------------------------------------------

check('paying the Citi card is a cost, under its own name', () => {
  // His call: the card's purchases never reach the bank feed, so
  // treating the payment as a transfer would leave about $10,700 a
  // month in no figure anywhere. It is carried as one lump, in a
  // category named for what it is -- a month of mixed buying arriving
  // as a single number. Filing it under Supplies would make Supplies
  // a lie.
  ['PAYMENT CITI CARD ONLINE WEB RASMY ALI',
   'CITI CARD ONLINE PAYMENT ACH ENTRY MEMO POSTED',
   'PAYMENT CITI AUTOPAY WEB RAZCO FOOD SUPERMARKE'].forEach((d) => {
    const r = classifyLine({ description: d, amount: -10663.85 }, { vendors: [], aliases: [] });
    assert.strictEqual(r.what, 'cost', d + ' should be a cost, got ' + r.what);
    assert.strictEqual(r.code, 'card_payment');
    assert.strictEqual(r.category_name, 'Credit card spending');
  });
});

check('the Citi pattern matches what the bank actually writes', () => {
  // The old pattern wanted "CARD PAYMENT". His bank writes "PAYMENT
  // CITI CARD ONLINE WEB", which contains no such phrase, so $42,900
  // since September fell through to `ask` and reached no figure at all.
  const r = classifyLine(
    { description: 'PAYMENT CITI CARD ONLINE WEB RASMY ALI', amount: -32240.07 },
    { vendors: [], aliases: [] });
  assert.notStrictEqual(r.what, 'ask');
});

check('a fuel pre-authorisation is not a purchase', () => {
  // A pump holds a token amount to check the card is live, reverses it,
  // then posts the real sum. Counting the hold files fuel never bought.
  const r = classifyLine({ description: 'PRE SHELL 12740573006 LOC', amount: -1.00 },
    { vendors: [], aliases: [] });
  assert.strictEqual(r.what, 'internal');
  assert.strictEqual(r.code, 'fuel_hold');
});

check('the card settlement deposit is never income', () => {
  // $1.19m of it since September. Sales are counted from the POS, so
  // counting the deposit as income too would double the takings.
  const r = classifyLine({ description: 'DEPOSIT MERCHANT BNKCD CCD', amount: 19502.87 },
    { vendors: [], aliases: [] });
  assert.strictEqual(r.what, 'internal');
  assert.strictEqual(r.code, 'card_settlement');
});

check('a real card PURCHASE is still a cost', () => {
  // The distinction that matters: buying on the card is spending,
  // paying the card off is not. Both say "card".
  const r = classifyLine(
    { description: 'DBT CRD 0926 28404739 FACEBK LSHSADEQS4 CARD# 5337', amount: -250 },
    { vendors: [], aliases: [] });
  assert.strictEqual(r.what, 'cost');
});


console.log('\nthe bills the app kept telling him to pay twice');

// Each of these four was on his screen saying "past due -- Pay now"
// while the money was already out of the account.

check('Frito-Lay, whose name the bank cuts in half', () => {
  const r = classifyLine(line({
    description: 'ROLLING ROLLING FRITO-LA CCD', amount: -377.28,
  }), CTX);
  assert.strictEqual(r.what, 'bill', JSON.stringify(r));
  assert.ok(r.invoice, 'no invoice was found for it');
  assert.strictEqual(r.invoice.invoice_id, 'i-frito-1');
  assert.strictEqual(r.vendor.vendor_id, 'v-frito');
});

check('Bimbo, spelled differently on his own vendor list', () => {
  // "Bimbo Bakires USA" here, "BIMBO BAKERIES" at the bank. No string
  // match will ever join those two, so the amount has to.
  const r = classifyLine(line({
    description: 'BBUSA BIMBO BAKERIES WEB RAZ ALI', amount: -135.00,
  }), CTX);
  assert.strictEqual(r.what, 'bill');
  assert.strictEqual(r.invoice.invoice_id, 'i-bimbo');
});

check('Valley Wide, still pending at the bank', () => {
  const r = classifyLine(line({
    description: 'VALLEY WIDE BEVE FINTECHEFT ACH ENTRY MEMO POSTED TODAY',
    amount: -1704.07, is_pending: true,
  }), CTX);
  // Pending is no longer a reason to ignore it. The money is committed,
  // and telling him to pay it a second time is the worse error by far.
  assert.strictEqual(r.what, 'bill', 'a pending draft was ignored again');
  assert.strictEqual(r.invoice.invoice_id, 'i-valley');
});

check('and it remembers how the bank spells the ones it had to guess', () => {
  const r = classifyLine(line({
    description: 'ROLLING ROLLING FRITO-LA CCD', amount: -377.28,
  }), CTX);
  assert.ok(r.teach_alias, 'nothing was learned, so next month needs the same coincidence');
  assert.strictEqual(r.teach_alias.vendor_id, 'v-frito');
});

check('once learned, the name alone is enough — any amount', () => {
  const taught = {
    vendors: VENDORS,
    aliases: [{ vendor_id: 'v-frito', alias_text: 'ROLLING ROLLING FRITO-LA CCD',
                squashed: 'ROLLINGROLLINGFRITOLACCD' }],
    openInvoices: OPEN,
  };
  const r = classifyLine(line({
    description: 'ROLLING ROLLING FRITO-LA CCD', amount: -9999.99,
  }), taught);
  assert.strictEqual(r.what, 'bill');
  assert.strictEqual(r.how, 'alias');
  assert.strictEqual(r.vendor.vendor_id, 'v-frito');
});

console.log('\nthe card transactions that reached no figure at all');

[
  ['DBT CRD 0926 28404739 FACEBK LSHSADEQS4 CARD# 5337', 360.00, 'FACEBK'],
  ['DBT CRD 2124 21100089 DIGITALOCEAN.COM DIGITALOCEAN.CA CARD# 5337', 210.38, 'DIGITALOCEAN'],
  ['DBT CRD 1829 23100037 TWILIO INC WWW.TWILIO.COCA CARD# 5337', 52.04, 'TWILIO'],
  ['DBT CRD 0401 23173046 WIRELESS INTERNET SERVI 559-7348601CA CARD# 5337', 150.00, 'WIRELESS'],
  ['DBT CRD 1837 29010784 MCDERMONTX LINDSAYCA CARD# 5337', 50.00, 'MCDERMONTX'],
].forEach(([desc, amt, merchant]) => {
  check('card 5337: ' + merchant + ' is a cost', () => {
    const r = classifyLine(line({ description: desc, amount: -amt }), CTX);
    assert.strictEqual(r.what, 'cost', JSON.stringify(r));
    assert.ok(String(r.merchant || '').indexOf(merchant) > -1,
      'merchant read as "' + r.merchant + '"');
  });
});

check('the card number never ends up in the merchant name', () => {
  const m = cardMerchant('DBT CRD 0926 28404739 FACEBK LSHSADEQS4 CARD# 5337');
  assert.ok(m.indexOf('5337') === -1, 'the card number is in there: ' + m);
  assert.ok(m.indexOf('28404739') === -1, 'the terminal id is in there: ' + m);
});

console.log('\nthe rest of the money that was going nowhere');

[
  ['PAYROLL RAZCO LINDSAY IN CCD', 6789.53, 'Payroll'],
  ['TAXDRAFT ASURE PAYROLL TA CCD', 7398.45, 'Payroll tax'],
  ['CDTFA EPMT CA DEPT TAX FEE CCD', 9233.00, 'Sales tax'],
  ['AWS', 168.74, 'Software'],
  ['ACH PYE-BARKER FIRE CCD', 60.30, 'Fire and alarm'],
  ['WORKWISE COMPLIA WORKWISE C ACH ENTRY', 800.00, 'Compliance'],
  ['CASH CONC NAVITAS CREDIT C PPD', 2407.26, 'Equipment lease'],
  ['CHK ORDERS HARLAND CLARKE PPD', 118.08, 'Bank charges'],
].forEach(([desc, amt, label]) => {
  check(label + ' is a cost, not a bill', () => {
    const r = classifyLine(line({ description: desc, amount: -amt }), CTX);
    assert.strictEqual(r.what, 'cost', JSON.stringify(r));
    assert.strictEqual(r.label, label);
  });
});

console.log('\nwhat must never be counted as a cost');

check('a card settlement arriving is his own money coming home', () => {
  const r = classifyLine(line({
    description: 'MERCHANT BNKCD DEPOSIT ACH ENTRY', amount: 14031.14,
  }), CTX);
  assert.strictEqual(r.what, 'internal');
});

check('and so is one going the other way', () => {
  const r = classifyLine(line({
    description: 'MERCHANT BNKCD DEPOSIT ACH ENTRY', amount: -3812.77,
  }), CTX);
  assert.strictEqual(r.what, 'internal',
    'a card settlement was about to be booked as an expense');
});

console.log('\nwhat it still refuses to guess');

check('three vendors called C&S means no answer', () => {
  const r = classifyLine(line({
    description: 'C&S WHOLESALE GR CCD', amount: -19518.36,
  }), CTX);
  assert.strictEqual(r.what, 'ask',
    'it picked one of three C&S vendors — that money would land on the wrong bills');
});

check('an amount matching two open invoices names neither', () => {
  const twins = {
    vendors: VENDORS,
    aliases: [],
    openInvoices: OPEN.concat([{
      invoice_id: 'i-twin', vendor_id: 'v-tony', invoice_number: 'X',
      invoice_date: '2026-11-02', due_date: '2026-11-02',
      total_amount: 377.28, amount_paid: 0, balance_due: 377.28,
    }]),
  };
  const r = classifyLine(line({
    description: 'SOMETHING UNREADABLE CCD', amount: -377.28,
  }), twins);
  assert.strictEqual(r.what, 'ask');
});

check('a coincidence from months away is not a match', () => {
  const old = {
    vendors: VENDORS, aliases: [],
    openInvoices: [{
      invoice_id: 'i-old', vendor_id: 'v-tony', invoice_number: 'OLD',
      invoice_date: '2026-01-05', due_date: '2026-01-20',
      total_amount: 377.28, amount_paid: 0, balance_due: 377.28,
    }],
  };
  const r = classifyLine(line({
    description: 'UNREADABLE CCD', amount: -377.28, posted_date: '2026-11-02',
  }), old);
  assert.strictEqual(r.what, 'ask', 'it reached ten months back for a matching figure');
});

check('a card purchase is never treated as a vendor bill', () => {
  // Even where a vendor of that name could exist. He was never invoiced
  // for it, so it is not accounts payable.
  const withFb = {
    vendors: VENDORS.concat([{ vendor_id: 'v-fb', name: 'FACEBK ADVERTISING' }]),
    aliases: [], openInvoices: OPEN,
  };
  const r = classifyLine(line({
    description: 'DBT CRD 0926 28404739 FACEBK LSHSADEQS4 CARD# 5337', amount: -360,
  }), withFb);
  assert.strictEqual(r.what, 'cost');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

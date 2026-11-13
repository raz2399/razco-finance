// What one line on the bank actually is.
//
// ---------------------------------------------------------------------
// The rule that makes this worth having
//
// EVERY debit is exactly one of three things. Nothing is allowed to fall
// through to nothing, because falling through to nothing is what went
// wrong: $63,000 left his account in six days and most of it became no
// payment, no invoice and no expense. The week looked cheaper than it
// was, and bills the bank had already paid still said "Pay now".
//
//   bill      a check or a vendor draft, paying something he was invoiced
//             for. The COST was counted the day the delivery landed, so
//             this must never touch the expense line again -- that is
//             charging him twice for one load of groceries.
//
//   cost      money out with no invoice behind it, ever: payroll, sales
//             tax, the card purchases on card 5337, software, utilities,
//             bank charges. These are real costs and were reaching
//             nothing at all.
//
//   internal  money moving between his own pockets. Never a cost.
//
// A fourth answer, `ask`, exists for lines that genuinely could be a
// bill but whose vendor cannot be told. Those go in front of him rather
// than being guessed at, because guessing puts one vendor's money
// against another vendor's bills and nobody finds out for months.
//
// ---------------------------------------------------------------------
// Why the card purchases were invisible
//
// They arrive as "DBT CRD 0926 28404739 FACEBK LSHSADEQS4 CARD# 5337".
// Nothing in the system looked at those, so Facebook, DigitalOcean,
// Twilio, the internet bill and the rest were money that left the bank
// and appeared in no figure anywhere.

// What a card line looks like, whatever was bought on it.
const CARD_SHAPED = /\bDBT CRD\b|\bPOS DEBIT\b|CARD#|\bIBT DEB\b/;

const up = (s) => String(s == null ? '' : s).toUpperCase();
const squash = (s) => up(s).replace(/[^A-Z0-9]/g, '');
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------
// Costs with no invoice behind them.
//
// Each carries the category the profit and loss should file it under, so
// the number is not just "other" forever. `test` is matched against the
// upper-cased description.

const COSTS = [
  // Payroll tax FIRST. "TAXDRAFT ASURE PAYROLL TA CCD" contains the word
  // payroll, so the broader rule would swallow it and call the tax draft
  // wages. The money lands in the same category either way, but a line
  // he reads should say what it is.
  { code: 'payroll_tax', test: /TAXDRAFT|ASURE/, label: 'Payroll tax', category: 'Payroll' },
  { code: 'payroll', test: /\bPAYROLL\b|RAZCO LINDSAY IN/, label: 'Payroll', category: 'Payroll' },
  { code: 'sales_tax', test: /CDTFA|DEPT TAX|BOARD OF EQUAL/, label: 'Sales tax', category: 'Taxes & Licenses' },
  { code: 'income_tax', test: /\bIRS\b|EFTPS|FRANCHISE TAX/, label: 'Tax', category: 'Taxes & Licenses' },
  { code: 'software', test: /\bAWS\b|GOOGLECLOUD|GOOGLE CLOUD|DIGITALOCEAN|TWILIO|ADOBE|MICROSOFT|NETLIFY|RAILWAY|OPENAI|ANTHROPIC|INTUIT|QBOOKS|AIPRM|SUPABASE|VERCEL|GODADDY|SQUARESPACE|AGILITYRETAIL/, label: 'Software', category: 'Software & Subscriptions' },
  { code: 'advertising', test: /FACEBK|FACEBOOK|META PLATFORMS|GOOGLE ADS/, label: 'Advertising', category: 'Advertising' },
  { code: 'utility', test: /WIRELESS INTERNET|EDISON|\bPG&?E\b|SO CAL GAS|WATER DEPT|CITY OF LINDSAY/, label: 'Utilities', category: 'Utilities' },
  { code: 'alarm_fire', test: /PYE-BARKER|ALARM|FIRE PROTECT/, label: 'Fire and alarm', category: 'Repairs & Maintenance' },
  { code: 'compliance', test: /WORKWISE|COMPLIA/, label: 'Compliance', category: 'Professional Services' },
  { code: 'equipment_lease', test: /NAVITAS|CASH CONC MILLENIUM|LEASE/, label: 'Equipment lease', category: 'Equipment Lease' },
  { code: 'bank_charge', test: /SERVICE CHARGE|ANALYSIS (CHARGE|FEE)|OVERDRAFT|NSF FEE|CHK ORDERS|HARLAND CLARKE/, label: 'Bank charges', category: 'Interest & Bank Fees' },
  // Paying the credit card, counted as spending on his instruction.
  //
  // The card's own purchases never reach the bank feed -- only this
  // monthly payment does -- so treating it as a transfer would leave
  // about $10,700 a month in no figure anywhere. He chose to carry it
  // as one lump rather than lose it, and it gets a category of its own
  // because it is not one kind of spending but a month of mixed buying
  // arriving as a single number. Filing it under Supplies would make
  // Supplies a lie.
  //
  // THE STANDING RISK: if that card's purchases are ever entered as
  // bills as well, the same money is counted twice, and nothing in the
  // data could tell. That is why the category is named for what it is.
  //
  // The pattern matches what his bank actually writes -- "PAYMENT CITI
  // CARD ONLINE WEB RASMY ALI" -- which the old one did not, so $42,900
  // since September reached no figure at all.
  { code: 'card_payment', test: /CITI\s*(CARD\s*)?(ONLINE|AUTOPAY)|CARD (ONLINE )?PAYMENT|CREDIT CRD AUTOPAY|CARDMEMBER SERV|CRCARDPMT|CAPITAL ONE/, label: 'Credit card payment', category: 'Credit card spending' },
  { code: 'loan', test: /\bLOAN\b|SBA |NOTE PAYMENT/, label: 'Loan payment', category: 'Interest & Bank Fees' },
  { code: 'insurance', test: /INSURANCE|PREMIUM|HARTFORD|STATE FARM|GEICO|PACERPYRLC/, label: 'Insurance', category: 'Insurance' },
  { code: 'rent', test: /\bRENT\b|LEASE PAYMENT/, label: 'Rent', category: 'Rent' },
  { code: 'fuel', test: /\bSHELL\b|\bCHEVRON\b|\bARCO\b|\b76\b|VALERO|FUEL|GASOLINE/, label: 'Fuel', category: 'Fuel & Vehicle' },
  { code: 'supplies', test: /AMAZON|AMZN|COSTCO|HOME DEPOT|LOWES|STAPLES|OFFICE DEPOT|WALMART|SAMS CLUB|ULINE|WEBSTAURANT/, label: 'Supplies', category: 'Supplies' },

  // LAST. Every card line says "DBT CRD" or "CARD#", so this rule
  // matches all of them -- and it used to sit above the merchant rules,
  // which meant it won every time and handed back no category at all.
  // Facebook, Twilio, DigitalOcean, Google Cloud, Railway, the internet
  // bill and the fuel all have rules of their own and reached none of
  // them: fifteen lines in the books as "card purchase, uncategorised".
  //
  // The same ordering mistake as payroll_tax under payroll, one line
  // further up. A rule that matches a FORM of payment has to come after
  // every rule that matches WHAT was paid for, because the form tells
  // you nothing and the merchant tells you everything.
  //
  // Reaching this one means the merchant is genuinely unrecognised. It
  // keeps a null category on purpose: inventing one would file real
  // money under a heading nobody chose, and "uncategorised" is a thing
  // he can see and fix.
  { code: 'card_purchase', test: /\bDBT CRD\b|\bPOS DEBIT\b|CARD#|\bIBT DEB\b/, label: 'Card purchase', category: null },
];

// Money moving between his own pockets. Never a cost, never income.
const INTERNAL = [
  { code: 'card_settlement', test: /MERCHANT BNKCD|BNKCD DEPOSIT|CARD SETTLE/ },

  // A fuel pump authorises a token amount to check the card is live,
  // then reverses it and posts the real sum. "PRE SHELL ... LOC" for a
  // dollar is a hold, not a purchase, and treating it as a cost files a
  // dollar of fuel that was never bought.
  { code: 'fuel_hold', test: /^PRE [A-Z]|PREAUTH|PRE-AUTH|AUTH HOLD/ },
  { code: 'cash_deposit', test: /BUSINESS DEPOSIT|CASH DEPOSIT|^DEPOSIT\b/ },
  { code: 'atm', test: /DLY SETTLE MVNT|ATM (LOAD|REPLENISH)/ },
  { code: 'transfer', test: /TRANSFER TO|TRANSFER FROM|INTERNAL TRANSFER|BOOK TRANSFER/ },
];

function firstMatch(list, text) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].test.test(text)) return list[i];
  }
  return null;
}

/**
 * Pull a merchant out of a card line.
 *
 * "DBT CRD 0926 28404739 FACEBK LSHSADEQS4 CARD# 5337" is really just
 * "FACEBK". The numbers are a terminal id and the card's last four, and
 * neither says anything about what was bought.
 */
function cardMerchant(description) {
  const d = up(description);
  if (!/\bDBT CRD\b|CARD#/.test(d)) return null;
  let s = d
    .replace(/\bDBT CRD\b/g, ' ')
    .replace(/CARD#\s*\d+/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // What is left often ends in a town and state: "... LINDSAYCA".
  s = s.replace(/\s*[A-Z]{2}$/, '').trim();
  return s || null;
}

/**
 * Which vendor a line belongs to, on evidence that cannot mean two
 * things.
 *
 * Aliases first -- those are the bank's own spelling, learned once and
 * worth more than any guess. Then the vendor's name, whole or truncated
 * the way a statement truncates it.
 *
 * Two different vendors matching means NO match. He has three vendors
 * whose names begin "C&S", and a line reading "C&S WHOLESALE GR" is
 * genuinely any of them.
 */
function headOf(s) {
  return s.slice(0, Math.max(8, Math.floor(s.length * 0.6)));
}

function vendorFor(description, vendors, aliases) {
  const d = squash(description);
  if (!d) return null;

  // An alias is a fact he gave us, or one proved by an exact amount.
  // Nothing outranks it.
  const list = aliases || [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const sq = a.squashed || squash(a.alias_text);
    if (sq && sq.length >= 4 && d.indexOf(sq) > -1) {
      const v = vendors.filter((x) => x.vendor_id === a.vendor_id)[0];
      if (v) return { vendor: v, how: 'alias' };
    }
  }

  const hits = {};
  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    const n = squash(v.name);
    if (n.length < 6) continue;
    if (d.indexOf(n) > -1 || d.indexOf(headOf(n)) > -1) hits[v.vendor_id] = v;
  }
  const ids = Object.keys(hits);
  if (ids.length !== 1) return null;
  return { vendor: hits[ids[0]], how: 'name' };
}

/**
 * One open invoice whose balance is this amount to the cent.
 *
 * This is the evidence that rescues the lines whose names cannot be
 * read. "ROLLING ROLLING FRITO-LA CCD" matches no vendor spelling he
 * has, but $377.28 is exactly what one open Frito-Lay invoice is for,
 * and nothing else on the books is for that figure. That is not a
 * guess; it is the same standard the matcher already holds itself to.
 *
 * Two invoices for the same figure means no answer. A window around the
 * date keeps a coincidence from six months away out of it.
 */
function invoiceForAmount(amount, postedDate, invoices, windowDays) {
  const amt = money(Math.abs(amount));
  if (!(amt > 0)) return null;
  const days = windowDays === undefined ? 45 : windowDays;

  const when = new Date(String(postedDate) + 'T12:00:00Z').getTime();
  const span = days * 24 * 60 * 60 * 1000;

  const hits = invoices.filter((inv) => {
    if (money(inv.balance_due) !== amt) return false;
    const d = inv.invoice_date || inv.due_date;
    if (!d) return true;
    const t = new Date(String(d) + 'T12:00:00Z').getTime();
    // A bill is paid after it is raised, and not months later.
    return t <= when + span && t >= when - span;
  });

  if (hits.length !== 1) return null;
  return hits[0];
}

/**
 * The whole answer for one line.
 *
 * { what: 'bill' | 'cost' | 'internal' | 'ask' | 'income', ... }
 */
function classifyLine(txn, ctx) {
  const vendors = (ctx && ctx.vendors) || [];
  const aliases = (ctx && ctx.aliases) || [];
  const invoices = (ctx && ctx.openInvoices) || [];
  const text = up(txn.description);
  const amount = money(txn.amount);

  const internal = firstMatch(INTERNAL, text);
  if (internal) return { what: 'internal', code: internal.code };

  if (amount >= 0) return { what: 'income', code: 'money_in' };

  const out = Math.abs(amount);
  if (!(out > 0)) return { what: 'internal', code: 'zero' };

  // ---- a check ------------------------------------------------------
  if (txn.check_number) {
    const byAmount = invoiceForAmount(out, txn.posted_date, invoices);
    return {
      what: 'bill',
      how: 'check',
      check_number: Number(txn.check_number),
      amount: out,
      invoice: byAmount || null,
      vendor: byAmount
        ? vendors.filter((v) => v.vendor_id === byAmount.vendor_id)[0] || null
        : null,
    };
  }

  // ---- a cost with no invoice behind it ------------------------------
  //
  // Checked BEFORE vendor matching on purpose. "ROLLING FRITO-LA" is a
  // vendor draft, but "DBT CRD ... FACEBK" is a card purchase even
  // though a vendor called Facebook could exist. A thing he was never
  // invoiced for is never accounts payable.
  const cost = firstMatch(COSTS, text);
  if (cost) {
    return {
      what: 'cost',
      code: cost.code,
      label: cost.label,
      category_name: cost.category,
      merchant: cardMerchant(txn.description) || null,
      // Whether it was a card is a fact about the line, not about which
      // rule happened to match it. Deriving it from the rule meant that
      // the moment Facebook started matching `advertising` instead of
      // the generic card rule, the same swipe began recording itself as
      // an ACH transfer.
      is_card: CARD_SHAPED.test(text),
      amount: out,
    };
  }

  // ---- a vendor draft -------------------------------------------------
  const found = vendorFor(txn.description, vendors, aliases);
  if (found) {
    const openForThem = invoices.filter((i) => i.vendor_id === found.vendor.vendor_id);
    const exact = invoiceForAmount(out, txn.posted_date, openForThem);
    return {
      what: 'bill',
      how: found.how === 'alias' ? 'alias' : 'vendor_name',
      vendor: found.vendor,
      invoice: exact || null,
      amount: out,
    };
  }

  // ---- the amount names it even when the words do not -----------------
  const byAmount = invoiceForAmount(out, txn.posted_date, invoices);
  if (byAmount) {
    const v = vendors.filter((x) => x.vendor_id === byAmount.vendor_id)[0] || null;
    return {
      what: 'bill',
      how: 'exact_amount',
      vendor: v,
      invoice: byAmount,
      amount: out,
      // Worth remembering: this is how the bank spells that vendor.
      teach_alias: v ? { vendor_id: v.vendor_id, alias_text: txn.description } : null,
    };
  }

  // ---- nothing certain ------------------------------------------------
  return { what: 'ask', amount: out, description: txn.description };
}

module.exports = {
  classifyLine, vendorFor, invoiceForAmount, cardMerchant,
  squash, headOf, COSTS, INTERNAL, CARD_SHAPED,
};

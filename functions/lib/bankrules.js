// What each line on the bank statement actually is.
//
// ---------------------------------------------------------------------
// The thing this file exists to prevent
//
// Sales are counted once, at the register, from Encore. When that same
// money later lands in the bank -- the card processor settling, a cash
// deposit going in, the ATM being reimbursed -- it is the SAME MONEY
// ARRIVING. It is not new income.
//
// Over the last year that is:
//
//   DEPOSIT MERCHANT BNKCD   299 deposits   $5,541,770   card settlements
//   BUSINESS DEPOSIT          36 deposits   $2,001,014   cash deposits
//   DLY SETTLE MVNT          167 credits       $68,020   ATM reimbursement
//
// Treat those as income and Razco's revenue reads $7.6m higher than it
// is. Every one of them is money that was already counted the day it was
// rung up. So each rule carries a `kind`, and `transfer` means: move the
// bank balance, never touch income.
//
// The ATM is the subtlest of the three. Raz loads the machine with store
// cash; customers withdraw it; the processor pays him back. Every single
// one of those 167 credits is a multiple of $20 -- which is what gives it
// away. It is his own cash coming home, not a penny of revenue. What IS
// revenue is the surcharge, which arrives separately and is about $88 a
// month.
//
// ---------------------------------------------------------------------
// kind
//   transfer  money moving between his own pockets. Never income, never
//             an expense. Changes the bank balance and nothing else.
//   income    money genuinely coming in that the register never saw.
//   expense   money genuinely going out.
//   settles   a payment already recorded here -- a check, a vendor draft.
//             Not a new expense: matching it marks the existing one paid.
//
// A line nothing matches is 'unknown', and unknown is shown to him rather
// than guessed at. A wrong label here is worse than no label, because a
// wrong one is silent.

// Order matters: the first match wins, so the specific sit above the
// general. Each `test` is matched against the UPPERCASED description.
const RULES = [
  // ---- money arriving that was already counted at the register ----
  {
    code: 'card_settlement',
    test: /DEPOSIT\s+MERCHANT\s+BNKCD|MERCHANT\s+BNKCD/,
    label: 'Card settlement',
    kind: 'transfer',
    direction: 'in',
    why: 'Card sales already counted at the register. This is that money arriving.',
  },
  {
    code: 'card_chargeback',
    // The same processor, going the other way.
    test: /DEPOSIT\s+MERCHANT\s+BNKCD|MERCHANT\s+BNKCD/,
    direction: 'out',
    label: 'Card chargeback or adjustment',
    kind: 'expense',
    why: 'Money taken back by the card processor.',
  },
  {
    code: 'cash_deposit',
    test: /BUSINESS\s+DEPOSIT|^DEPOSIT$|CASH\s+DEPOSIT|BRANCH\s+DEPOSIT/,
    direction: 'in',
    label: 'Cash deposit',
    kind: 'transfer',
    why: 'Till cash already counted at the register. This is it reaching the bank.',
  },
  {
    code: 'atm_reimbursement',
    test: /DLY\s+SETTLE\s+MVNT|ATM\s+SETTLE|VAULT\s+CASH/,
    direction: 'in',
    label: 'ATM cash back to you',
    kind: 'transfer',
    why: 'Your own cash dispensed by the ATM, being paid back. Not a sale.',
  },
  {
    code: 'atm_surcharge',
    test: /PAYMENT\s+ALLIANCE|ATM\s+SURCHARGE|SURCHARGE\s+REV/,
    direction: 'in',
    label: 'ATM surcharge earned',
    kind: 'income',
    why: 'Your share of the fee the ATM charges. Real income the register never sees.',
  },

  // ---- money going out that is already on the books ----
  {
    code: 'check',
    test: /^CHECK\b|CHECK\s*#/,
    direction: 'out',
    label: 'Check',
    kind: 'settles',
    why: 'A check you wrote. Matching it marks that check cleared.',
  },
  {
    // A check that came back. On the statement these read as plain
    // credits with wording like "RETURN SIGNATURE IRREGULAR" or
    // "SIGNATURE MISSING", and left unnamed they look exactly like
    // income -- money arriving, no vendor, no explanation. They are not
    // income. They are a payment that failed and still has to be made,
    // which makes them worth seeing rather than quietly banking.
    code: 'returned_item',
    test: /RETURN\s+(DUPLICATE|UNUSABLE|SIGNATURE|UNCOLLECTED|NSF)|SIGNATURE\s+MISSING|DUPLICATE\s+PRESENTMENT|RETURNED\s+ITEM|REDEPOSIT/,
    label: 'Check came back',
    kind: 'settles',
    why: 'A check was returned unpaid. The money is back, and so is the bill.',
  },

  // ---- vendors that draft the account themselves ----
  // Named from a year of real statements rather than guessed at, so a
  // draft lands against the right vendor instead of "unknown".
  {
    code: 'vendor_draft',
    test: /C&S\s+WHOLESALE|TONYS\s+FINE|FRITO-LA|BIMBO\s+BAKERIES|PEPSI\s+BEVERAGE|REYESCOCACOLA|FINTECHEFT|VALLEY\s+WIDE\s+BEVE|BUENO\s+BEVERAGE|DONAGHY\s+SALES|B\s*H\s+DISTRIBUTO|PAYMENT\s+BH\b|SUPERVALU|GO\s*GO\s+BAKE|CARGILL\s+MEAT|UNFI\b|KEHE\b/,
    direction: 'out',
    label: 'Vendor draft',
    kind: 'settles',
    why: 'A vendor taking payment straight from the account on terms.',
  },

  // ---- running the place ----
  {
    // Above plain payroll on purpose. "TAXDRAFT ASURE PAYROLL TA" reads
    // as payroll to any rule looking for the word, and reads as tax to
    // any rule looking for TAXDRAFT -- so it would land wherever the
    // list happened to be ordered, which is not a decision anyone made.
    // It is both, it is labour cost, and it gets a name of its own so
    // nobody has to wonder which bucket it fell into.
    code: 'payroll_tax',
    test: /TAXDRAFT|PAYROLL\s+TAX|941\s+PAYMENT|EFTPS/,
    direction: 'out',
    label: 'Payroll tax',
    kind: 'expense',
    why: 'Payroll taxes remitted by the payroll service. Part of what labour costs.',
  },
  {
    code: 'payroll',
    test: /PAYROLL|ASURE\s+PAYROLL|FINGERCHECK/,
    direction: 'out',
    label: 'Payroll',
    kind: 'expense',
    why: 'Wages, or the payroll service that pays them.',
  },
  {
    code: 'tax',
    test: /TAXDRAFT|CDTFA|CA\s+DEPT\s+TAX|FRANCHISE\s+TAX|IRS\b|EFTPS/,
    direction: 'out',
    label: 'Tax',
    kind: 'expense',
    why: 'Sales tax, payroll tax or income tax going to the state or the IRS.',
  },
  {
    code: 'utility',
    test: /EDISON|SOCALGAS|SO\s*CAL\s*GAS|UNWIRED\s+BROADBAN|GETUNWIRED|WIRELESS\s+INTERNET|WATER\s+DEPT|WASTE\s+MANAGEMENT|MID[\s-]*VALLEY\s+DISPOSAL|DISPOSAL/,
    direction: 'out',
    label: 'Utility',
    kind: 'expense',
    why: 'Power, gas, water, waste or internet.',
  },
  {
    code: 'insurance',
    test: /HARTFORD|MERCURY\s+INS|STATE\s+FUND|WORKERS\s+COMP|TRAVELERS|SAGESURE|BUS\s+INSUR|PROGRESSIVE\s+INS/,
    direction: 'out',
    label: 'Insurance',
    kind: 'expense',
    why: 'Premiums. Usually monthly, and usually the same figure.',
  },
  {
    // Licences and permits a grocery store has to keep current: the ABC
    // licence, the county health permit, DMV for the vehicles. They are
    // not "tax" and they are not "supplies", and filed under either one
    // they stop being findable the week the renewal is late.
    code: 'license',
    test: /ALCBEVCTL|ALC\s*BEV|ENV\s+HEALT|HEALTH\s+DEPT|CA\s*DMV|STATE\s+OF\s+CALIF\s+DMV|DEPARTMENT\s+OF\s+REAL\s+EST|LICENSERNW|ALLPAID|BUSINESS\s+LICEN/,
    direction: 'out',
    label: 'Licence or permit',
    kind: 'expense',
    why: 'A licence, permit or registration the store has to keep current.',
  },
  {
    code: 'subscription',
    test: /QBOOKS\s+ONL|INTUIT|ADOBE|MICROSOFT|GOOGLE\s*\*?\s*CLOUD|GOOGLE\s|DROPBOX|SQUARE\s*SPACE|SQUARESPACE|GODADDY|NETFLIX|SPOTIFY|ZOOM\.US|SHOPIFY|MAILCHIMP|AMAZON\s+WEB\s+SERVICES|AWS\.AMAZON|TWILIO|ANTHROPIC|OPENAI|GLIDE\b|GLIDEAPPS|RAILWAY|DIGITALOCEAN|AIPRM|CAPTIONS\.AI|BOLT\s*\(|STACKBLITZ|ENVATO|OPTISIGNS|MCAFEE|SINCH|PREPLY|H2O\s+WIRELESS|ONLINEED|MY\s+CORPORATION/,
    direction: 'out',
    label: 'Subscription',
    kind: 'expense',
    why: 'A recurring software or service charge. Worth a look now and then.',
  },
  {
    code: 'advertising',
    test: /FACEBK|FACEBOOK|META\s+PLATFORMS|GOOGLE\s+ADS|NEXO\s*MEDIA|VISTAPRINT|EXACTO\s+MENU/,
    direction: 'out',
    label: 'Advertising',
    kind: 'expense',
    why: 'Marketing: social ads, printing, menus and signage.',
  },
  {
    code: 'fuel',
    test: /\bCHEVRON\b|SHELL\s+OIL|\bSHELL\s|\bVALERO\b|\bARCO\b|FASTRIP|GAWFCO|X-PRESS\s+FOOD|\b76\s*-\s*DBA/,
    direction: 'out',
    label: 'Fuel',
    kind: 'expense',
    why: 'Fuel, usually for the delivery vehicle.',
  },
  {
    code: 'lease',
    test: /NAVITAS|LEASE\s+PAYMENT|EQUIPMENT\s+FIN|DE\s+LAGE|BALBOA\s+CAPITAL/,
    direction: 'out',
    label: 'Equipment lease',
    kind: 'expense',
    why: 'A financed piece of equipment.',
  },
  {
    code: 'bank_fee',
    test: /ACCOUNT\s+ANALYSIS|SERVICE\s+CHARGE|OVERDRAFT|NSF\s+FEE|WIRE\s+FEE|MONTHLY\s+FEE|CHANGE\s+ORDER\s+FEE|W\/D\s+SVC/,
    direction: 'out',
    label: 'Bank charge',
    kind: 'expense',
    why: 'What the bank takes for keeping the account.',
  },
  {
    // The bank fixing its own arithmetic. Cents, usually, and in both
    // directions. Counted as income a correction would be nonsense, so
    // it is named as what it is and kept out of every total.
    code: 'bank_correction',
    test: /DEBIT\s+CORRECTION|CREDIT\s+CORRECTION|ADJUSTMENT\s+TO|ERROR\s+CORRECT/,
    label: 'Bank correction',
    kind: 'transfer',
    why: 'The bank correcting an earlier entry. Not money earned or spent.',
  },
  {
    code: 'card_payment',
    test: /CITI\s+CARD|CAPITAL\s+ONE|CRCARDPMT|AMEX\s+EPAYMENT|CHASE\s+CREDIT\s+CRD|CARD\s+PAYMENT/,
    direction: 'out',
    label: 'Credit card payment',
    kind: 'transfer',
    why: 'Paying a card balance. What was BOUGHT on the card is the expense, '
       + 'not this -- counting both would charge it twice.',
  },
  {
    code: 'collections',
    test: /BROWN\s+AND\s+JOSEPH|TCCG|COLLECTION\s+AGENCY/,
    direction: 'out',
    label: 'Collections',
    kind: 'expense',
    why: 'An account that went to collections.',
  },
  {
    // Named merchants sit above the generic card rule on purpose, so a
    // card swipe at Home Depot reads "Supplies" rather than the useless
    // truth that it was a card.
    code: 'supplies',
    test: /ULINE|WEBSTAURANT|GRAINGER|HOME\s*DEPOT|LOWES|COSTCO|SAMS\s*CLUB|OFFICE\s+DEPOT|AMAZON\s+MKTPL|SMART\s+AND\s+FINAL|WAL-?MART|TARGET\s+T|ID\s+IMAGES|DURAFAST|G\s*&\s*I\s+INDUSTRIES|ACTION\s+GLASS|HUSSMANN|MILLENIUM/,
    direction: 'out',
    label: 'Supplies',
    kind: 'expense',
    why: 'Bags, cleaning, shelving, hardware -- things to run the place.',
  },
  {
    code: 'repairs',
    test: /PYE-?BARKER|FIRE\s+PROTECT|REFRIGERAT|PLUMB|ELECTRIC\s+SERVICE|HVAC|PEST\s+CONTROL|ORKIN|TERMINIX/,
    direction: 'out',
    label: 'Repairs and maintenance',
    kind: 'expense',
    why: 'Keeping the building and the equipment working.',
  },
  {
    // The catch-all for a card swipe nothing above recognised. It is a
    // real expense and it says so, but the label is deliberately vague
    // because the only honest thing left to say is where it happened.
    code: 'debit_card',
    test: /^DBT\s*CRD|^POS\s+DEB|^DDA\s+B\/P|^ATM\s+W\/D|DEBIT\s+CARD\s+PURCHASE|POS\s+PURCHASE|CARD#/,
    direction: 'out',
    label: 'Card purchase',
    kind: 'expense',
    why: 'Bought on the debit card. Open it to say what it was for.',
  },
  {
    code: 'card_chargeback',
    test: /^CHARGEBACK|CHARGE\s*BACK/,
    direction: 'out',
    label: 'Chargeback',
    kind: 'expense',
    why: 'A card sale taken back after the fact.',
  },
  {
    code: 'transfer_out',
    test: /TRANSFER\s+TO|ONLINE\s+TRANSFER|XFER\s+TO|ZELLE|PAYONEER/,
    direction: 'out',
    label: 'Transfer out',
    kind: 'transfer',
    why: 'Money moving to another account of yours.',
  },
];

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Bank descriptions are truncated and stripped: "TONYS FINE F#" for
// "Tony's Fine Foods". So the comparison is made on letters and digits
// only, and the vendor's name has to appear in the description from its
// start -- a loose "contains" would match "BH" inside half the file.
const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function matchVendor(text, vendors) {
  const flat = squash(text);
  let best = null;
  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    const names = [v.name].concat(v.aliases || []);
    for (let j = 0; j < names.length; j++) {
      const n = squash(names[j]);
      // Short names are too easy to hit by accident inside a bank line.
      if (n.length < 6) continue;
      // Either the description carries the whole name, or it carries a
      // truncated front of it -- which is what a statement actually does.
      const head = n.slice(0, Math.max(8, Math.floor(n.length * 0.6)));
      if (flat.indexOf(n) > -1 || flat.indexOf(head) > -1) {
        if (!best || n.length > best.len) best = { vendor_id: v.vendor_id, name: v.name, len: n.length };
      }
    }
  }
  return best;
}

/**
 * What one line is.
 *
 * Returns { code, label, kind, why, confident }.
 * confident is false when nothing matched -- and an unconfident line is
 * shown to him to name, never quietly filed under something plausible.
 */
function classify(description, amount, vendors) {
  const text = String(description == null ? '' : description).toUpperCase();
  const dir = Number(amount) >= 0 ? 'in' : 'out';

  for (let i = 0; i < RULES.length; i++) {
    const r = RULES[i];
    if (r.direction && r.direction !== dir) continue;
    if (!r.test.test(text)) continue;
    return {
      code: r.code, label: r.label, kind: r.kind, why: r.why, confident: true,
    };
  }

  // Nothing on the fixed list. Before giving up, try his own vendors --
  // all 255 of them, by name and by the spellings on the paper.
  //
  // This is why the hardcoded vendor list above is a starting point and
  // not the answer: a vendor added next month would never appear there,
  // and its drafts would come up unnamed for ever. Here they are matched
  // against the vendor table, so the system learns a vendor once.
  if (dir === 'out' && vendors && vendors.length) {
    const hit = matchVendor(text, vendors);
    if (hit) {
      return {
        code: 'vendor_draft',
        label: 'Vendor draft',
        kind: 'settles',
        vendor_id: hit.vendor_id,
        vendor_name: hit.name,
        why: hit.name + ' taking payment straight from the account.',
        confident: true,
      };
    }
  }

  return {
    code: 'unknown',
    label: dir === 'in' ? 'Money in — not named yet' : 'Money out — not named yet',
    // Unknown money in is NOT assumed to be income. Assuming would inflate
    // the figure on his screen, which is the one thing this must not do.
    kind: 'unknown',
    why: 'Nothing on file matches this description. Say what it is and it '
       + 'will be recognised from now on.',
    confident: false,
  };
}

/**
 * A whole statement, added up by what each line actually is.
 *
 * The headline it produces: real_income and real_expense EXCLUDE every
 * transfer, so the figures can be put next to register sales without
 * counting the same dollar twice.
 */
function summarise(rows, vendors) {
  const out = {
    real_income: 0,
    real_expense: 0,
    moved_in: 0,      // transfers arriving: settlements, deposits, ATM
    moved_out: 0,
    settles: 0,       // checks and drafts already on the books
    unknown_in: 0,
    unknown_out: 0,
    unknown_count: 0,
    by_code: {},
  };

  (rows || []).forEach((row) => {
    const amount = money(row.amount);
    const c = classify(row.description, amount, vendors);

    const b = out.by_code[c.code] || (out.by_code[c.code] = {
      code: c.code, label: c.label, kind: c.kind, count: 0, total: 0,
    });
    b.count += 1;
    b.total = money(b.total + amount);

    if (c.kind === 'income') out.real_income = money(out.real_income + amount);
    else if (c.kind === 'expense') out.real_expense = money(out.real_expense + Math.abs(amount));
    else if (c.kind === 'settles') out.settles = money(out.settles + Math.abs(amount));
    else if (c.kind === 'transfer') {
      if (amount >= 0) out.moved_in = money(out.moved_in + amount);
      else out.moved_out = money(out.moved_out + Math.abs(amount));
    } else {
      out.unknown_count += 1;
      if (amount >= 0) out.unknown_in = money(out.unknown_in + amount);
      else out.unknown_out = money(out.unknown_out + Math.abs(amount));
    }
  });

  return out;
}

module.exports = { classify, summarise, matchVendor, RULES };

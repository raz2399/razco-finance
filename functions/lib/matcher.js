// Tying the bank to the books.
//
// ---------------------------------------------------------------------
// The problem
//
// There are 2,660 lines on the bank statement and 6 payments in the
// books. Those are two separate piles of truth that have never been put
// next to each other. Until they are, the balance on the screen is
// something the system was told rather than something it can prove, and
// a check that was written but never cashed looks exactly like a check
// that was never written at all.
//
// ---------------------------------------------------------------------
// What a match is, and what it is not
//
// A match is an assertion that THIS line on the bank is THAT row in the
// books. It is only ever made on evidence that cannot mean two things:
//
//   check number + exact amount   the bank says check 9887 took $24,272.80
//                                 and the books say check 9887 was for
//                                 $24,272.80. Nothing else it could be.
//
//   vendor + exact amount         a draft from a vendor whose open invoice
//                                 is for exactly that figure, to the cent.
//
// Everything short of that is NOT matched. A line can be *recognised* --
// the system knows it is payroll, or a card settlement -- without being
// matched to anything, because payroll is not an A/P item and never will
// be. Recognised and matched are different claims and the difference
// matters: recognised says "I know what this is", matched says "I know
// which row of your books this is".
//
// A near-miss is never quietly rounded into a match. If check 9887
// cleared for a different figure than the one written down, that is not
// an inconvenience to be smoothed over -- it is either a mistake or
// somebody altering a check, and it goes in front of Raz with both
// numbers showing.
//
// ---------------------------------------------------------------------
// Order of precedence, strongest evidence first
//
//   1. a rule Raz taught it          he said so; nothing outranks that
//   2. check number + amount         unambiguous
//   3. check number, amount differs  matched, and flagged loudly
//   4. vendor draft + exact amount   unambiguous
//   5. classified, nothing to match  recognised
//   6. nothing                       unknown, and shown to him

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const abs = (n) => Math.abs(money(n));
const up = (s) => String(s == null ? '' : s).toUpperCase();

// Two figures are the same figure when they are the same to the cent.
// No tolerance. A tolerance is a decision to be wrong sometimes, and the
// amount of money it would save is not worth what it costs in trust.
const sameMoney = (a, b) => abs(a) === abs(b);

/**
 * Index the books once, so matching 2,660 lines is 2,660 lookups rather
 * than 2,660 scans. At this size the difference is a page that loads and
 * a page that times out.
 */
function index(payments, invoices) {
  const byCheck = {};
  const byVendor = {};

  (payments || []).forEach((p) => {
    if (p.status === 'void' || p.status === 'stopped') return;
    if (p.check_number != null && p.check_number !== '') {
      const k = String(Number(p.check_number));
      (byCheck[k] || (byCheck[k] = [])).push(p);
    }
  });

  (invoices || []).forEach((i) => {
    if (i.status === 'void' || i.status === 'paid') return;
    if (!i.vendor_id) return;
    (byVendor[i.vendor_id] || (byVendor[i.vendor_id] = [])).push(i);
  });

  return { byCheck: byCheck, byVendor: byVendor };
}

/**
 * A rule Raz taught. Patterns are plain text, compared uppercased, and
 * the longest matching pattern wins -- so "BIMBO BAKERIES" beats a
 * broader "BIMBO" he may have entered first.
 */
function learned(description, rules) {
  const text = up(description);
  let best = null;
  (rules || []).forEach((r) => {
    const pat = up(r.pattern);
    if (!pat || text.indexOf(pat) === -1) return;
    if (!best || pat.length > up(best.pattern).length) best = r;
  });
  return best;
}

/**
 * One bank line against the books.
 *
 * `classified` is what lib/bankrules.js made of the description. It is
 * passed in rather than computed here so this file stays about matching
 * and that one stays about naming.
 *
 * `ctx.claimed` is the set of rows already spoken for by an earlier line.
 * Without it, one check written for $1,000 would happily satisfy two
 * separate $1,000 debits and the books would say a bill was paid twice.
 * A row can only be matched once, and the first claim wins -- which is
 * why matchAll works through the biggest amounts first, where a wrong
 * claim would cost the most.
 *
 * Returns the whole decision, including why, because a match a person
 * cannot audit is a match they have to take on faith.
 */
function matchOne(txn, ctx) {
  const claimed = ctx.claimed || {};
  const free = (rows) => (rows || []).filter((r) => {
    const id = r.payment_id || r.invoice_id;
    return !claimed[id];
  });
  const amount = money(txn.amount);
  const out = {
    bank_txn_id: txn.bank_txn_id,
    status: 'unmatched',
    kind: 'unknown',
    code: 'unknown',
    label: null,
    vendor_id: null,
    category_id: null,
    matched_type: null,
    matched_id: null,
    note: null,
    // Set when the books and the bank disagree about something they
    // both claim to know. These are the lines worth his time.
    exception: null,
  };

  // ---- 1. what he taught it ------------------------------------------
  const rule = learned(txn.description, ctx.rules);
  if (rule) {
    out.kind = rule.kind;
    out.code = rule.code || 'taught';
    out.label = rule.label || null;
    out.vendor_id = rule.vendor_id || null;
    out.category_id = rule.category_id || null;
    out.status = 'recognized';
    out.note = 'You named this one.';
    // A taught rule names the line; it can still match a row below if
    // the evidence is there, so this does not return yet.
  } else if (ctx.classified) {
    out.kind = ctx.classified.kind;
    out.code = ctx.classified.code;
    out.label = ctx.classified.label;
    if (ctx.classified.vendor_id) out.vendor_id = ctx.classified.vendor_id;
    if (ctx.classified.confident) {
      out.status = 'recognized';
      out.note = ctx.classified.why || null;
    }
  }

  // ---- 1b. a check that came back ------------------------------------
  // The bank hands the money back and says so in passing: "SIGNATURE
  // MISSING", "RETURN UNUSABLE IMAGE". On the statement it is a credit
  // like any other, and the natural reading is that money arrived.
  //
  // What actually happened is that a bill did not get paid. Nobody is
  // told. The vendor waits, the books say paid, and the only trace is
  // one line among thousands. So it is raised every time, by name.
  if (out.code === 'returned_item') {
    out.status = 'recognized';
    out.kind = 'settles';
    out.exception = {
      severity: 'warn',
      what: 'check_returned_unpaid',
      detail: 'A check for ' + abs(amount).toFixed(2) + ' came back unpaid'
        + (txn.check_number ? ' (check ' + txn.check_number + ')' : '')
        + '. Whoever it was to has not been paid.',
    };
    out.note = out.exception.detail;
    return out;
  }

  // ---- 2 & 3. a check number is a serial number ----------------------
  if (txn.check_number != null && txn.check_number !== '') {
    const hits = free(ctx.byCheck[String(Number(txn.check_number))]);

    const exact = hits.filter((p) => sameMoney(p.amount, amount));
    if (exact.length === 1) {
      out.status = 'matched';
      out.kind = 'settles';
      out.code = 'check';
      out.matched_type = 'payment';
      out.matched_id = exact[0].payment_id;
      out.vendor_id = exact[0].vendor_id || out.vendor_id;
      out.note = 'Check ' + txn.check_number + ' cleared for the amount written.';
      return out;
    }

    if (hits.length === 1 && !exact.length) {
      // The number is right and the money is not. This is the single
      // most worthwhile thing this whole file can find.
      out.status = 'matched';
      out.kind = 'settles';
      out.code = 'check';
      out.matched_type = 'payment';
      out.matched_id = hits[0].payment_id;
      out.vendor_id = hits[0].vendor_id || out.vendor_id;
      out.exception = {
        severity: 'critical',
        what: 'check_amount_differs',
        detail: 'Check ' + txn.check_number + ' was written for '
          + abs(hits[0].amount).toFixed(2) + ' and cleared the bank for '
          + abs(amount).toFixed(2) + '.',
      };
      out.note = out.exception.detail;
      return out;
    }

    if (exact.length > 1) {
      // Two payments, same number, same amount. Not a thing that should
      // exist; it means something was entered twice.
      out.status = 'unmatched';
      out.exception = {
        severity: 'warn',
        what: 'duplicate_check',
        detail: 'There are ' + exact.length + ' payments recorded as check '
          + txn.check_number + '. One of them is a duplicate.',
      };
      out.note = out.exception.detail;
      return out;
    }

    // A check on the bank with nothing in the books. Expected, for now:
    // a year of checks was written through QuickBooks. Named so it can
    // be counted and offered back to him, not silently dropped.
    out.kind = 'settles';
    out.code = 'check';
    out.label = 'Check ' + txn.check_number;
    out.status = 'unmatched';
    out.note = 'Check ' + txn.check_number + ' cleared, but no record of writing it.';
    out.exception = {
      severity: 'info',
      what: 'check_not_in_books',
      detail: out.note,
    };
    return out;
  }

  // ---- 4. a vendor taking its own money ------------------------------
  if (out.vendor_id && amount < 0) {
    const open = free(ctx.byVendor[out.vendor_id]);
    const exact = open.filter((i) => sameMoney(i.balance_due, amount));
    if (exact.length === 1) {
      out.status = 'matched';
      out.kind = 'settles';
      out.matched_type = 'invoice';
      out.matched_id = exact[0].invoice_id;
      out.note = 'Pays invoice ' + (exact[0].invoice_number || '')
        + ' in full, to the cent.';
      return out;
    }
    if (exact.length > 1) {
      // Two open invoices for the same vendor and the same amount. Either
      // could be the one that got paid, and picking is guessing.
      out.status = 'recognized';
      out.note = 'Two open invoices for this vendor are both for '
        + abs(amount).toFixed(2) + '. Say which one this paid.';
      out.exception = {
        severity: 'warn',
        what: 'ambiguous_invoice',
        detail: out.note,
      };
      return out;
    }
  }

  // ---- 5 & 6. recognised, or honestly unknown ------------------------
  if (out.status === 'unmatched' && out.kind !== 'unknown') out.status = 'recognized';
  if (out.status === 'unmatched') {
    out.note = 'Nothing on file matches this. Name it once and it will be '
      + 'recognised from now on.';
  }
  return out;
}

/**
 * The whole statement. Returns a decision per line plus the tally that
 * tells Raz how much of his bank is now accounted for -- which is the
 * one number that says whether this worked.
 *
 * Worked through biggest amount first, for the reason given on matchOne:
 * a row can only be claimed once, so the line where a wrong claim would
 * cost the most gets to choose first.
 */
function matchAll(txns, ctx) {
  const decisions = [];
  const claimed = {};
  const tally = {
    total: 0,
    matched: 0,
    recognized: 0,
    unmatched: 0,
    exceptions: 0,
    checks_not_in_books: 0,
    checks_not_in_books_value: 0,
    unknown_value_out: 0,
    unknown_value_in: 0,
  };

  const ordered = (txns || []).slice().sort((a, b) => abs(b.amount) - abs(a.amount));

  ordered.forEach((t) => {
    const d = matchOne(t, {
      byCheck: ctx.byCheck,
      byVendor: ctx.byVendor,
      rules: ctx.rules,
      claimed: claimed,
      classified: ctx.classify ? ctx.classify(t.description, t.amount) : null,
    });
    if (d.matched_id) claimed[d.matched_id] = 1;
    decisions.push(d);

    tally.total += 1;
    if (d.status === 'matched') tally.matched += 1;
    else if (d.status === 'recognized') tally.recognized += 1;
    else tally.unmatched += 1;

    if (d.exception) {
      tally.exceptions += 1;
      if (d.exception.what === 'check_not_in_books') {
        tally.checks_not_in_books += 1;
        tally.checks_not_in_books_value = money(
          tally.checks_not_in_books_value + abs(t.amount));
      }
    }
    if (d.status === 'unmatched' && d.kind === 'unknown') {
      if (money(t.amount) < 0) {
        tally.unknown_value_out = money(tally.unknown_value_out + abs(t.amount));
      } else {
        tally.unknown_value_in = money(tally.unknown_value_in + abs(t.amount));
      }
    }
  });

  return { decisions: decisions, tally: tally };
}

module.exports = { index, matchOne, matchAll, learned, sameMoney };

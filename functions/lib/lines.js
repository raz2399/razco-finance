// The product lines on a delivery invoice.
//
// ---------------------------------------------------------------------
// Why this is worth the trouble
//
// 116 invoices are on the books and not one of them has a single line
// behind it. The total is enough to pay a bill and no use at all for the
// question that actually decides whether a grocery store makes money:
// did this case cost more than it cost last time.
//
// A wholesaler puts a price up a few cents a case and says nothing. The
// invoice total looks like every other invoice total, because the order
// was a different size. The shelf price does not move, because nobody
// knows. The margin on that item goes quietly, and it keeps going until
// somebody compares two invoices side by side, which nobody ever does by
// hand. Lines are what let the system do it instead.
//
// ---------------------------------------------------------------------
// What a line is allowed to claim
//
// The reader gives quantity, unit cost and line total as printed, and is
// told not to make them agree. So they often will not, and a line whose
// arithmetic is wrong is a line that was misread. Rather than silently
// correcting it, or silently keeping it, each line is checked and the
// bad ones are marked: the figures still go in, because a misread line
// is still evidence of a product delivered, but nothing downstream is
// allowed to treat it as a price.
//
// A price nobody can trust is worse than no price, because it looks
// exactly like one that can be.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
};

const text = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s || null;
};

/**
 * Does the line's own arithmetic hold up?
 *
 * Quantity times unit cost should be the line total. A cent or two of
 * rounding is ordinary; anything more means one of the three was read
 * wrong, and there is no way to tell which.
 */
function adds_up(qty, unit, total) {
  if (qty === null || unit === null || total === null) return null;  // can't say
  const want = money(qty * unit);
  return Math.abs(want - money(total)) <= 0.02;
}

/**
 * Turn what the reader saw into rows for invoice_lines.
 *
 * Returns { lines, kept, dropped, suspect } -- dropped are rows with
 * nothing usable in them at all, suspect are rows whose arithmetic
 * disagrees with itself.
 */
function linesFrom(extracted, invoice_id) {
  const raw = (extracted && extracted.lines) || [];
  const out = [];
  let dropped = 0;
  let suspect = 0;

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const description = text(r.description);
    const code = text(r.code);
    const pack = text(r.pack);
    const quantity = num(r.quantity);
    const unit_cost = num(r.unit_cost);
    let line_total = num(r.line_total);

    // Nothing to identify it and no money on it: not a line, probably a
    // ruled-off row or a page header the reader picked up.
    if (!description && !code && line_total === null && unit_cost === null) {
      dropped += 1;
      continue;
    }

    // Only a quantity and a unit price: the total is arithmetic, not a
    // guess, so it can be filled in.
    if (line_total === null && quantity !== null && unit_cost !== null) {
      line_total = money(quantity * unit_cost);
    }

    const ok = adds_up(quantity, unit_cost, line_total);
    if (ok === false) suspect += 1;

    out.push({
      invoice_id: invoice_id,
      line_no: i + 1,
      code: code,
      description: description,
      pack: pack,
      quantity: quantity,
      unit_cost: unit_cost,
      line_total: line_total === null ? null : money(line_total),
      // Marked, not dropped. The product was delivered either way; it is
      // only the price that cannot be trusted, and the price is the part
      // the watch would otherwise act on.
      figures_disagree: ok === false,
    });
  }

  return { lines: out, kept: out.length, dropped: dropped, suspect: suspect };
}

/**
 * Do the lines account for the invoice?
 *
 * Lines that come to far less than the bill mean the reader missed a
 * page or a column, and a price watch built on half an invoice would be
 * comparing this month's half against last month's whole. Tax, freight
 * and deposits are not product lines, so the lines are expected to come
 * to the subtotal where there is one, and only roughly to the total.
 */
function linesCover(lines, extracted) {
  const sum = lines.reduce((t, l) => t + (l.line_total || 0), 0);
  const subtotal = num(extracted && extracted.subtotal);
  const total = num(extracted && extracted.total);
  const against = subtotal !== null ? subtotal : total;
  if (against === null || !(against > 0) || !lines.length) {
    return { checked: false, covered: null, sum: money(sum), against: against };
  }
  const share = sum / against;
  return {
    checked: true,
    // Generous on the upside because tax or freight may have slipped in
    // as a line; strict on the downside, which is the failure that
    // matters -- lines missed entirely.
    covered: share >= 0.9 && share <= 1.15,
    share: Math.round(share * 1000) / 1000,
    sum: money(sum),
    against: against,
  };
}

/** Only the columns the table really has, so a row cannot be refused whole. */
function onlyRealColumns(row, columns) {
  const out = {};
  Object.keys(row).forEach((k) => { if (columns && columns[k]) out[k] = row[k]; });
  return out;
}

module.exports = { linesFrom, linesCover, adds_up, onlyRealColumns, money, num, text };

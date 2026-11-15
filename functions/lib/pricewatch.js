// What a case cost last time, and what it costs now.
//
// ---------------------------------------------------------------------
// The leak this is for
//
// A wholesaler puts a case up forty cents and tells nobody. The invoice
// total looks ordinary, because the order was a different size. The
// shelf price does not move, because nobody knows. The margin on that
// item goes, and it keeps going, and the only way to catch it by hand is
// to hold two invoices side by side — which nobody does, on four hundred
// lines a week.
//
// ---------------------------------------------------------------------
// Why this is mostly about refusing to report
//
// An alert he cannot trust is worse than no alert, because after the
// third false one he stops reading them, and then the true one goes past
// as well. Every rule below exists to throw a comparison away:
//
//   - same vendor only. Two wholesalers charging different prices for
//     the same tomatoes is not a price rise, it is Tuesday.
//   - same pack only. $18 for a 25 lb case and $18 for a 10 lb case is a
//     large rise reported as none, and the reverse reads as a collapse.
//   - same item, and identity has to be real. A vendor's own code is
//     reliable; a description is not, because the same product is
//     abbreviated differently from one invoice to the next.
//   - both sides' arithmetic has to hold up. A misread line is a
//     fictional price, and a fictional price makes a fictional alert.
//   - the move has to be big enough in BOTH senses: a percentage and a
//     dollar amount. Two cents on a 60-cent item is a 3% rise worth
//     nobody's attention.
//
// What is left is small, and that is the point.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Below these, a change is noise. Both must be cleared: a big percentage
// of a tiny number is still a tiny number, and a big number that is a
// rounding error on a pallet is not a price change.
const MIN_PCT = 4;
const MIN_DOLLARS = 0.25;

/** The same product, next month, from the same vendor. */
function keyOf(line, vendor_id) {
  const pack = String(line.pack || '').toUpperCase().replace(/\s+/g, ' ').trim();

  // A vendor's own item code is the only identity worth trusting.
  if (line.code) {
    return vendor_id + '|#' + String(line.code).toUpperCase().trim() + '|' + pack;
  }

  // Without a code, the description has to carry it, and only when it is
  // substantial enough to mean something. "TOM" matches half the produce
  // list; "ROMA TOMATO 6X6" does not. Short descriptions are refused
  // rather than matched loosely, because a wrong match invents a price
  // change out of two different products.
  const d = String(line.description || '')
    .toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (d.length < 8) return null;
  return vendor_id + '|~' + d + '|' + pack;
}

/** Can this line's unit price be believed at all? */
function usable(line) {
  if (line.figures_disagree) return false;
  const u = Number(line.unit_cost);
  return isFinite(u) && u > 0;
}

/**
 * Compare each item's latest price against the one before it.
 *
 * `lines` are invoice_lines rows carrying vendor_id and invoice_date,
 * newest or oldest order does not matter.
 *
 * Returns the moves worth his attention, biggest annual cost first,
 * because a small rise on something bought weekly beats a large one on
 * something bought once.
 */
function priceMoves(lines, opts) {
  const minPct = (opts && opts.min_pct) || MIN_PCT;
  const minDollars = (opts && opts.min_dollars) || MIN_DOLLARS;

  const byItem = {};
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!usable(l)) continue;
    const k = keyOf(l, l.vendor_id);
    if (!k) continue;
    (byItem[k] = byItem[k] || []).push(l);
  }

  const moves = [];
  Object.keys(byItem).forEach((k) => {
    const hist = byItem[k].slice().sort((a, b) =>
      String(a.invoice_date) < String(b.invoice_date) ? -1 : 1);
    if (hist.length < 2) return;

    const now = hist[hist.length - 1];
    const before = hist[hist.length - 2];

    // The same invoice twice is not two deliveries. Without this, a
    // bill entered once and scanned again reads as a price change.
    if (now.invoice_id === before.invoice_id) return;
    if (String(now.invoice_date) === String(before.invoice_date)) return;

    const from = money(before.unit_cost);
    const to = money(now.unit_cost);
    if (!(from > 0) || !(to > 0)) return;

    const diff = money(to - from);
    if (diff === 0) return;
    const pct = Math.round((diff / from) * 1000) / 10;
    if (Math.abs(pct) < minPct) return;
    if (Math.abs(diff) < minDollars) return;

    // How often it is bought decides how much the change actually costs.
    const seen = hist.length;
    const qty = Number(now.quantity) || 1;
    const perDelivery = money(diff * qty);

    moves.push({
      key: k,
      vendor_id: now.vendor_id,
      vendor: now.vendor || null,
      code: now.code || null,
      description: now.description || before.description || null,
      pack: now.pack || null,
      from: from,
      to: to,
      diff: diff,
      pct: pct,
      direction: diff > 0 ? 'up' : 'down',
      last_seen: now.invoice_date,
      previously: before.invoice_date,
      deliveries: seen,
      quantity_now: qty,
      // What the change costs on one delivery of the size he just took.
      cost_per_delivery: perDelivery,
      invoice_id: now.invoice_id,
      previous_invoice_id: before.invoice_id,
    });
  });

  moves.sort((a, b) => Math.abs(b.cost_per_delivery) - Math.abs(a.cost_per_delivery));
  return moves;
}

/** One line he can read without working anything out. */
function summarise(moves) {
  const up = moves.filter((m) => m.direction === 'up');
  const down = moves.filter((m) => m.direction === 'down');
  const cost = money(up.reduce((t, m) => t + m.cost_per_delivery, 0));
  const saved = money(-down.reduce((t, m) => t + m.cost_per_delivery, 0));

  if (!moves.length) {
    return 'No case price has moved enough to matter since the last delivery.';
  }
  const bits = [];
  if (up.length) {
    bits.push(up.length + ' item' + (up.length === 1 ? '' : 's') + ' up, costing '
      + '$' + cost.toFixed(2) + ' more on the last delivery of each');
  }
  if (down.length) {
    bits.push(down.length + ' down, saving $' + saved.toFixed(2));
  }
  return bits.join('. ') + '.';
}

module.exports = { priceMoves, summarise, keyOf, usable, MIN_PCT, MIN_DOLLARS };

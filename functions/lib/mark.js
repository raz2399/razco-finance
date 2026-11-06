// What a statement line is, and whether it is finished with.
//
// This is the highlighter. He asked for cleared items in yellow, and the
// only honest way to do that is to decide the question in one place: two
// screens working it out separately would eventually disagree, and a
// disagreement here looks like money appearing or vanishing.
//
// Four states, and every line is exactly one of them:
//
//   settled   it posted, and the books have an answer for it. Marked.
//   needs     it posted, and something is still missing. Marked, but
//             with a red edge -- money leaving against nothing you owe
//             is not finished with, however yellow it looks.
//   pending   the bank can still change its mind. Nothing is marked
//             until it cannot.
//   in        money arriving.
//
// Nothing here talks to the database, so the rules can be tested
// against made-up rows instead of against his real books.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const OPEN = ['approved', 'scheduled', 'partially_paid'];

/**
 * The one open invoice whose balance is exactly this amount.
 *
 * Returns null the moment two invoices could be meant. That is the whole
 * point of it: a guess that puts one vendor's check against another
 * vendor's bill stays invisible until a statement arrives months later,
 * and by then both vendors are wrong. Unambiguous or nothing.
 *
 * The date window stops a check from being matched to a bill that was
 * not in existence anywhere near it.
 */
function soleInvoiceFor(amount, when, invoices) {
  const amt = money(Math.abs(Number(amount) || 0));
  if (!(amt > 0)) return null;

  const t = new Date(String(when) + 'T12:00:00Z').getTime();
  const span = 45 * 24 * 60 * 60 * 1000;
  const windowed = isFinite(t);

  const hits = [];
  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    if (money(inv.balance_due) !== amt) continue;
    const d = inv.invoice_date || inv.due_date;
    if (windowed && d) {
      const it = new Date(String(d) + 'T12:00:00Z').getTime();
      if (isFinite(it) && (it > t + span || it < t - span)) continue;
    }
    hits.push(inv);
    if (hits.length > 1) return null;   // ambiguous: stop looking
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Read one bank line against the books.
 *
 * `pay` is the payments row carrying this bank_txn_id, or null.
 * `vName` maps vendor_id to a name. `invoices` is the open ones.
 */
function readRow(t, pay, vName, invoices) {
  const amount = money(t.amount);
  const pending = !!t.is_pending;

  const out = {
    bank_txn_id: t.bank_txn_id,
    date: t.posted_date,
    description: t.description || '',
    amount: amount,
    check_number: t.check_number || (pay && pay.check_number) || null,
    pending: pending,
    vendor: pay && pay.vendor_id ? (vName || {})[pay.vendor_id] || null : null,
    in_books: !!pay,
    is_cost: pay ? pay.settles_ap === false : false,
    suggest: null,
    needs: null,
    state: 'settled',
  };

  if (amount > 0) {
    // Money in. Nothing to chase, nothing to pay twice.
    out.state = pending ? 'pending' : 'in';
    return out;
  }

  if (!pay) {
    // Money left the account and nothing in the books knows about it.
    out.needs = 'not_in_books';
    out.state = pending ? 'pending' : 'needs';
    return out;
  }

  if (pay.settles_ap !== false && !pay.vendor_id) {
    // A check that cleared with nobody against it. This is the one that
    // used to make the system ask him to pay a vendor the bank had
    // already paid, so it gets a suggestion where the amount is certain.
    out.needs = 'name';
    const hit = soleInvoiceFor(amount, t.posted_date, invoices || []);
    if (hit) {
      out.suggest = {
        payment_id: pay.payment_id,
        vendor_id: hit.vendor_id,
        vendor: (vName || {})[hit.vendor_id] || null,
        invoice_id: hit.invoice_id,
        invoice_number: hit.invoice_number || null,
        amount: money(hit.balance_due),
        why: 'exact amount, one open invoice',
      };
    }
    out.state = pending ? 'pending' : 'needs';
    return out;
  }

  // Either it is against a vendor, or it is a cost that was never a bill.
  // Both are answered for.
  out.state = pending ? 'pending' : 'settled';
  return out;
}

/** The tally under the page. */
function tally(rows) {
  const c = { settled: 0, needs: 0, pending: 0, in: 0, can_name: 0 };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    c[r.state] = (c[r.state] || 0) + 1;
    if (r.suggest && !r.pending) c.can_name += 1;
  }
  return c;
}

module.exports = { money, soleInvoiceFor, readRow, tally, OPEN };

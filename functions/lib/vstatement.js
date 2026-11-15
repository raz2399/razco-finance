// Their list against his.
//
// ---------------------------------------------------------------------
// What this is for
//
// Once a month a wholesaler sends a statement: their own account of
// what is still owed. Checking it against his own books is the job that
// catches the things nothing else can -- a delivery that never got
// entered, a check they have not credited, an invoice billed twice, a
// price adjusted without telling anyone. Done by hand it means two
// lists and a ruler, so it does not get done, and the first anyone
// hears of a problem is a vendor putting the store on hold.
//
// ---------------------------------------------------------------------
// The four answers, and why each matters
//
//   agreed        both sides have it at the same money. Most lines.
//   amount_differs both have the invoice, the figures do not match.
//                 Usually a credit one side has applied and the other
//                 has not -- the most common real finding.
//   theirs_only   they are billing something he has no record of. Either
//                 a delivery that was never entered, or something he
//                 never had. Both are worth knowing and they look
//                 identical until he checks.
//   ours_only     he has a bill they are not showing. Usually because
//                 they have it as paid, which is fine -- or because he
//                 entered it twice, which is not.
//
// The reconciliation never writes anything. It reports a disagreement
// between two records and the resolution is a conversation with the
// vendor, not an edit; a system that silently adjusted his books to
// match a photograph would be forging agreement rather than finding it.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Invoice numbers as printed differ in punctuation and padding between
 * a vendor's system and what was typed or read here, so they are
 * compared on their digits and letters alone -- INV-004471, 004471 and
 * "4471 " are one invoice.
 *
 * Leading zeros go too, but only when what is left still has digits: a
 * reference that is all zeros stays as it is rather than becoming empty.
 */
function refKey(n) {
  const s = String(n == null ? '' : n).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  const trimmed = s.replace(/^0+/, '');
  return trimmed || s;
}

/**
 * The number inside the reference.
 *
 * A vendor prints INV-004471 and his books say 4471. Stripping leading
 * zeros off the whole string does not help, because here they sit
 * behind a prefix -- so the digits at the end are pulled out and
 * compared on their own.
 *
 * Only when there are at least four of them. Three or fewer matches far
 * too much: every reference ending in "1" would pair with every other,
 * and a false pair does not merely miss a problem, it reports a
 * disagreement between two invoices that have nothing to do with each
 * other.
 */
function numKey(n) {
  const s = String(n == null ? '' : n).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/([0-9]+)$/);
  if (!m) return null;
  const digits = m[1].replace(/^0+/, '') || '0';
  return digits.length >= 4 ? '#' + digits : null;
}

/**
 * Compare a statement's lines against his open bills for that vendor.
 *
 * `theirs` are the statement items, `ours` are invoices rows.
 */
function compare(theirs, ours, opts) {
  const tol = (opts && opts.tolerance) || 0.01;

  const mine = {};
  const byNumber = {};
  const minePlain = [];
  (ours || []).forEach((i) => {
    const k = refKey(i.invoice_number);
    const nk = numKey(i.invoice_number);
    const row = {
      invoice_id: i.invoice_id,
      invoice_number: i.invoice_number,
      invoice_date: i.invoice_date,
      // What he still owes on it, which is what a statement shows too.
      amount: money(i.balance_due !== undefined && i.balance_due !== null
        ? i.balance_due : i.total_amount),
      total: money(i.total_amount),
      status: i.status,
      matched: false,
    };
    if (k) (mine[k] = mine[k] || []).push(row);
    if (nk) (byNumber[nk] = byNumber[nk] || []).push(row);
    minePlain.push(row);
  });

  const out = { agreed: [], amount_differs: [], theirs_only: [], ours_only: [] };

  (theirs || []).forEach((t) => {
    const amount = money(t.amount);
    const k = refKey(t.invoice_number);
    const line = {
      invoice_number: t.invoice_number || null,
      invoice_date: t.invoice_date || null,
      amount: amount,
      kind: t.kind || 'other',
    };

    // A payment or credit THEY list is their side of something already
    // settled here; it is not a bill to match against an open invoice,
    // so matching it by reference would pair it with the very invoice
    // it paid and report a disagreement that is not one.
    if (line.kind === 'payment' || line.kind === 'credit') {
      line.note = line.kind === 'payment'
        ? 'a payment they have recorded'
        : 'a credit they have given';
      out.theirs_only.push(line);
      return;
    }

    // The reference exactly as both sides wrote it comes first. Only
    // when that finds nothing is the bare number tried, so a loose
    // match can never beat an exact one.
    let candidates = k ? (mine[k] || []).filter((m) => !m.matched) : [];
    if (!candidates.length) {
      const nk = numKey(t.invoice_number);
      candidates = nk ? (byNumber[nk] || []).filter((m) => !m.matched) : [];
    }
    if (!candidates.length) {
      out.theirs_only.push(line);
      return;
    }

    // Where a reference appears twice, take the one closest in money
    // rather than the first, so a duplicate reference does not pair the
    // wrong pair and invent two disagreements out of one.
    candidates.sort((a, b) =>
      Math.abs(a.amount - amount) - Math.abs(b.amount - amount));
    const hit = candidates[0];
    hit.matched = true;

    const gap = money(amount - hit.amount);
    if (Math.abs(gap) <= tol) {
      out.agreed.push(Object.assign({}, line, {
        invoice_id: hit.invoice_id, ours: hit.amount,
      }));
    } else {
      out.amount_differs.push(Object.assign({}, line, {
        invoice_id: hit.invoice_id,
        theirs: amount,
        ours: hit.amount,
        gap: gap,
        // Which way he is exposed. They want more than the books say is
        // the one that costs money if nobody looks.
        they_want_more: gap > 0,
      }));
    }
  });

  minePlain.forEach((m) => {
    if (!m.matched) {
      out.ours_only.push({
        invoice_id: m.invoice_id,
        invoice_number: m.invoice_number,
        invoice_date: m.invoice_date,
        amount: m.amount,
        status: m.status,
      });
    }
  });

  const theirTotal = money((theirs || []).reduce((t, x) => t + money(x.amount), 0));
  const ourTotal = money(minePlain.reduce((t, x) => t + x.amount, 0));

  return Object.assign(out, {
    their_total: theirTotal,
    our_total: ourTotal,
    gap: money(theirTotal - ourTotal),
    counts: {
      agreed: out.agreed.length,
      amount_differs: out.amount_differs.length,
      theirs_only: out.theirs_only.length,
      ours_only: out.ours_only.length,
    },
  });
}

/** One line he can act on. */
function summarise(r, stated_total) {
  const bits = [];
  if (r.counts.amount_differs) {
    bits.push(r.counts.amount_differs + ' invoice'
      + (r.counts.amount_differs === 1 ? '' : 's') + ' where the figures disagree');
  }
  if (r.counts.theirs_only) {
    bits.push(r.counts.theirs_only + ' line'
      + (r.counts.theirs_only === 1 ? '' : 's') + ' they show and you do not');
  }
  if (r.counts.ours_only) {
    bits.push(r.counts.ours_only + ' bill'
      + (r.counts.ours_only === 1 ? '' : 's') + ' you have and they do not');
  }

  const head = !bits.length
    ? 'Everything on the statement matches your books.'
    : bits.join(', ') + '.';

  // Their own printed total against the lines they printed. When those
  // two disagree the statement is internally inconsistent, and nothing
  // worked out from its lines can be trusted until that is explained.
  let note = null;
  if (stated_total !== null && stated_total !== undefined) {
    const theirs = money(stated_total);
    if (Math.abs(theirs - r.their_total) > 0.02) {
      note = 'Their own lines come to $' + r.their_total.toFixed(2)
        + ' but the statement says $' + theirs.toFixed(2)
        + '. Something on the page was not read, or their total is wrong.';
    }
  }

  return { says: head, warning: note };
}

module.exports = { compare, summarise, refKey, numKey, money };

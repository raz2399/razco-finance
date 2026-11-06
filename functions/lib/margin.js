// Margin by department: sales against what was bought.
//
// ---------------------------------------------------------------------
// What this is, and what it honestly is not
//
// This puts the POS's sales for a department next to the invoices coded
// to that department. It is NOT cost of goods sold, and calling it that
// would be the "wrong numbers on screen" he has told me to avoid.
//
// Cost of goods sold is opening stock plus purchases minus closing
// stock. Nothing here counts stock. So in any single week the figure is
// noisy in a way that means nothing: buy a pallet of beef on the Friday
// and meat looks like it lost money; sell through it the next week with
// no delivery and meat looks like it printed money. Neither happened.
//
// Over a longer stretch the noise cancels, because a grocery store's
// shelf holds roughly the same stock at the start of a month as at the
// end. Four weeks is about where it starts being worth reading, which is
// why that is the default and why anything shorter is labelled as
// unreliable rather than quietly shown.
//
// So every figure comes back saying which it is -- `sales`, `purchases`,
// `difference` -- and the word "margin" is used only with the window
// attached. The screen says the same. A grocer who knows the difference
// between purchases and cost can use this immediately; one who is told
// it is margin will trust a number that is not one yet.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Departments that are collected on somebody else's behalf rather than
// bought and resold. A margin on these is meaningless -- the money is
// never the store's -- so they are reported apart rather than dragging
// the total around.
const PASSTHROUGH = {
  '5': 'Bag fee',
  '11': 'CRV soda',
  '12': 'Beer bottle deposit',
  '18': 'CRV beverage',
  '50': 'Blackhawk gift cards',
};

/**
 * Put sales and purchases side by side, department by department.
 *
 * `sales`     rows of { department_id, net_sales_amount }
 * `purchases` rows of { department_id, amount }
 * `names`     { department_id: name }
 * `weeks`     how long the window is, for the honesty line
 */
/**
 * Is a percentage worth printing at all?
 *
 * Two things ruin it, and both are true of his books today:
 *
 *   - too short a window, where the figure tracks deliveries
 *   - too much buying with no department, where most of a department's
 *     cost is simply missing from the sum
 *
 * With 68% of his buying uncoded, meat came out at 74.5% and produce at
 * -94.5%. Both are nonsense, and both are the sort of nonsense that
 * looks like news: he could believe meat was having a record month. So
 * when the inputs cannot support a percentage, none is given -- the
 * sales and buying columns still show, because those are facts, but the
 * column that would be read as margin stays empty and says why.
 */
function trustworthy(weeks, codedShare) {
  return Number(weeks) >= 4 && Number(codedShare) >= 0.75;
}

function byDepartment(sales, purchases, names, weeks, uncodedTotal) {
  const dept = {};
  const touch = (id) => {
    const key = String(id);
    if (!dept[key]) {
      dept[key] = {
        department_id: key,
        name: (names || {})[key] || ('Department ' + key),
        sales: 0,
        purchases: 0,
        passthrough: !!PASSTHROUGH[key],
      };
    }
    return dept[key];
  };

  (sales || []).forEach((r) => {
    if (r.department_id === null || r.department_id === undefined) return;
    const d = touch(r.department_id);
    d.sales = money(d.sales + money(r.net_sales_amount));
  });

  (purchases || []).forEach((r) => {
    if (r.department_id === null || r.department_id === undefined) return;
    const d = touch(r.department_id);
    d.purchases = money(d.purchases + money(r.amount));
  });

  const rows = [];
  Object.keys(dept).forEach((k) => {
    const d = dept[k];
    d.difference = money(d.sales - d.purchases);

    // A percentage needs something to be a percentage OF, and it needs
    // both halves present. Sales with no purchases coded is not a 100%
    // margin, it is a department nobody has coded a vendor to -- so it
    // gets no figure and says why instead.
    if (d.passthrough) {
      d.pct = null;
      d.note = 'collected for someone else, not resold';
    } else if (d.sales <= 0) {
      d.pct = null;
      d.note = d.purchases > 0 ? 'bought, nothing sold under this department' : null;
    } else if (d.purchases <= 0) {
      d.pct = null;
      d.note = 'no vendor is coded to this department yet';
    } else {
      d.pct = Math.round((d.difference / d.sales) * 1000) / 10;
      d.note = null;
    }
    rows.push(d);
  });

  rows.sort((a, b) => (b.sales - a.sales) || a.name.localeCompare(b.name));

  const real = rows.filter((r) => !r.passthrough);
  const coded = real.filter((r) => r.purchases > 0 && r.sales > 0);

  const totals = {
    sales: money(real.reduce((t, r) => t + r.sales, 0)),
    purchases: money(real.reduce((t, r) => t + r.purchases, 0)),
    // Only the departments with both halves. A total that mixed coded
    // and uncoded departments would read as a store-wide margin while
    // being mostly a measure of how much coding is left to do.
    comparable_sales: money(coded.reduce((t, r) => t + r.sales, 0)),
    comparable_purchases: money(coded.reduce((t, r) => t + r.purchases, 0)),
    departments_comparable: coded.length,
    departments_total: real.length,
  };
  totals.difference = money(totals.sales - totals.purchases);
  totals.comparable_pct = totals.comparable_sales > 0
    ? Math.round(((totals.comparable_sales - totals.comparable_purchases)
        / totals.comparable_sales) * 1000) / 10
    : null;

  const w = Number(weeks) || 0;

  // How much of the window's buying actually has a department. The
  // denominator includes the uncoded pile, because that is the point:
  // coded buying over all buying is the share of cost these percentages
  // can even see.
  const uncoded = money(uncodedTotal);
  const allBuying = money(totals.purchases + uncoded);
  const codedShare = allBuying > 0 ? totals.purchases / allBuying : 0;
  const ok = trustworthy(w, codedShare);
  const pc = Math.round(codedShare * 100);

  // When the inputs cannot carry a percentage, take every percentage
  // away rather than printing one with a warning beside it. A number on
  // a screen outlives the sentence next to it.
  if (!ok) {
    rows.forEach((r) => {
      if (r.pct !== null) {
        r.pct = null;
        if (!r.note) r.note = 'not enough coded buying yet to say';
      }
    });
    totals.comparable_pct = null;
  }

  let whyNot = null;
  if (!ok && w < 4 && codedShare < 0.75) {
    whyNot = 'Two things first: this window is only ' + w + ' week'
      + (w === 1 ? '' : 's') + ' long, and only ' + pc
      + '% of your buying has a department. A percentage would be a guess.';
  } else if (!ok && w < 4) {
    whyNot = 'This window is only ' + w + ' week' + (w === 1 ? '' : 's')
      + ' long, so a percentage would track deliveries rather than margin.';
  } else if (!ok) {
    whyNot = 'Only ' + pc + '% of your buying has a department yet, so most of '
      + 'the cost is missing from these lines and a percentage would read far '
      + 'too high.';
  }

  return {
    rows: rows,
    totals: totals,
    weeks: w,
    uncoded_total: uncoded,
    coded_share: Math.round(codedShare * 1000) / 10,
    trustworthy: ok,
    why_not: whyNot,
    // The caveat travels with the numbers rather than living only on a
    // screen somebody might change later.
    reliable: w >= 4,
    basis: 'sales against purchases coded to the department; stock is not counted',
    caution: w >= 4
      ? null
      : 'Over ' + (w === 1 ? 'one week' : w + ' weeks') + ' this swings with '
        + 'deliveries rather than with margin: one pallet bought and not yet '
        + 'sold makes a department look like it lost money. Four weeks or more '
        + 'before reading anything into it.',
  };
}

module.exports = { byDepartment, trustworthy, money, PASSTHROUGH };

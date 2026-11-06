// Margin by department.
//
// He said it plainly: do not put false data or wrong numbers on the
// screen. A margin figure is the easiest place in the whole system to do
// that, because a wrong one is perfectly plausible -- 31% on meat reads
// like a good month whether or not it is true.
//
// The two ways this goes wrong, both guarded here:
//
//   1. A percentage worked out from half the facts. Sales with no
//      purchases coded is not a 100% margin, it is an uncoded vendor.
//      Showing 100% would have him believing produce was free.
//   2. A short window read as margin. Purchases are not cost of goods
//      sold -- no stock is counted -- so one week swings with deliveries.
//      The caveat has to travel with the numbers, not sit on a screen
//      somebody might redesign later.

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { byDepartment, trustworthy, PASSTHROUGH } =
  require(path.join(ROOT, 'functions', 'lib', 'margin.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const NAMES = { '1': 'GROCERY', '3': 'MEAT', '6': 'PRODUCE', '5': 'BAG FEE', '11': 'CRV SODA' };
const row = (id, name) => ({ department_id: id, name: name });
const find = (out, id) => out.rows.filter((r) => r.department_id === id)[0];

// ---------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------

check('sales and purchases line up by department', () => {
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 10000 }],
    [{ department_id: '3', amount: 7000 }],
    NAMES, 4);
  const meat = find(out, '3');
  assert.strictEqual(meat.sales, 10000);
  assert.strictEqual(meat.purchases, 7000);
  assert.strictEqual(meat.difference, 3000);
  assert.strictEqual(meat.pct, 30);
  assert.strictEqual(meat.name, 'MEAT');
});

check('many rows for one department add up', () => {
  const out = byDepartment(
    [{ department_id: '6', net_sales_amount: 100 }, { department_id: '6', net_sales_amount: 50.55 }],
    [{ department_id: '6', amount: 40.25 }, { department_id: '6', amount: 10 }],
    NAMES, 4);
  const p = find(out, '6');
  assert.strictEqual(p.sales, 150.55);
  assert.strictEqual(p.purchases, 50.25);
});

check('a department bought from but never sold under is flagged, not divided', () => {
  const out = byDepartment([], [{ department_id: '3', amount: 500 }], NAMES, 4);
  const meat = find(out, '3');
  assert.strictEqual(meat.pct, null);
  assert.ok(/nothing sold/.test(meat.note));
});

// ---------------------------------------------------------------------
// Refusing to invent a percentage
// ---------------------------------------------------------------------

check('sales with NO purchases coded gives no percentage', () => {
  // The dangerous one. $107,000 of produce sales with no produce vendor
  // coded is not a 100% margin -- but that is exactly what a naive
  // (sales - purchases) / sales would print, and it looks like a
  // triumph rather than like missing data.
  const out = byDepartment(
    [{ department_id: '6', net_sales_amount: 107357.87 }], [], NAMES, 4);
  const p = find(out, '6');
  assert.strictEqual(p.pct, null);
  assert.strictEqual(p.purchases, 0);
  assert.ok(/no vendor is coded/.test(p.note));
});

check('the store total only counts departments with both halves', () => {
  // Grocery is coded, produce is not. A total over both would read as a
  // store margin of 62% while really measuring how much coding is left.
  const out = byDepartment(
    [{ department_id: '1', net_sales_amount: 100000 },
     { department_id: '6', net_sales_amount: 100000 }],
    [{ department_id: '1', amount: 75000 }],
    NAMES, 4);
  assert.strictEqual(out.totals.comparable_sales, 100000);
  assert.strictEqual(out.totals.comparable_purchases, 75000);
  assert.strictEqual(out.totals.comparable_pct, 25);
  assert.strictEqual(out.totals.departments_comparable, 1);
  assert.strictEqual(out.totals.departments_total, 2);
  // The raw sales total is still the truth about sales.
  assert.strictEqual(out.totals.sales, 200000);
});

check('zero sales and zero purchases is not a division', () => {
  const out = byDepartment(
    [{ department_id: '1', net_sales_amount: 0 }],
    [{ department_id: '1', amount: 0 }], NAMES, 4);
  assert.strictEqual(find(out, '1').pct, null);
});

check('rows with no department are dropped, not counted as a department', () => {
  const out = byDepartment(
    [{ department_id: null, net_sales_amount: 999 },
     { department_id: '1', net_sales_amount: 10 }],
    [], NAMES, 4);
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.totals.sales, 10);
});

// ---------------------------------------------------------------------
// Money that is not his
// ---------------------------------------------------------------------

check('bag fees and CRV are set apart, never given a margin', () => {
  // Collected on somebody else's behalf. A margin on a bottle deposit is
  // not a small error, it is a category error -- and it would drag the
  // store total around.
  const out = byDepartment(
    [{ department_id: '5', net_sales_amount: 1789.20 },
     { department_id: '11', net_sales_amount: 2552.40 },
     { department_id: '1', net_sales_amount: 10000 }],
    [{ department_id: '1', amount: 8000 }], NAMES, 4);

  assert.strictEqual(find(out, '5').passthrough, true);
  assert.strictEqual(find(out, '5').pct, null);
  assert.strictEqual(find(out, '11').passthrough, true);
  // Kept out of the totals entirely.
  assert.strictEqual(out.totals.sales, 10000);
  assert.strictEqual(out.totals.departments_total, 1);
});

check('the passthrough list covers his real non-merchandise departments', () => {
  ['5', '11', '12', '18', '50'].forEach((id) => {
    assert.ok(PASSTHROUGH[id], 'department ' + id + ' should be passthrough');
  });
  assert.ok(!PASSTHROUGH['3'], 'meat is not passthrough');
});

// ---------------------------------------------------------------------
// The caveat travels with the numbers
// ---------------------------------------------------------------------

check('a short window is marked unreliable and says why', () => {
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 10000 }],
    [{ department_id: '3', amount: 18000 }], NAMES, 1);
  assert.strictEqual(out.reliable, false);
  assert.ok(/one pallet|deliveries/.test(out.caution));
  // The figures are still given -- labelled, not withheld.
  assert.strictEqual(find(out, '3').difference, -8000);
});

check('four weeks or more is reliable enough to read', () => {
  const out = byDepartment([], [], NAMES, 4);
  assert.strictEqual(out.reliable, true);
  assert.strictEqual(out.caution, null);
});

check('every result says what it is based on', () => {
  const out = byDepartment([], [], NAMES, 8);
  assert.ok(/stock is not counted/.test(out.basis));
  assert.strictEqual(out.weeks, 8);
});

check('biggest department first, so the money is at the top', () => {
  const out = byDepartment(
    [{ department_id: '6', net_sales_amount: 107357 },
     { department_id: '1', net_sales_amount: 296399 },
     { department_id: '3', net_sales_amount: 274637 }],
    [], NAMES, 4);
  assert.deepStrictEqual(out.rows.map((r) => r.name), ['GROCERY', 'MEAT', 'PRODUCE']);
});

check('an unnamed department is still shown, by its number', () => {
  // A department added in the POS and not yet named must not vanish: its
  // sales are real money.
  const out = byDepartment([{ department_id: '77', net_sales_amount: 500 }], [], NAMES, 4);
  assert.strictEqual(find(out, '77').name, 'Department 77');
  assert.strictEqual(out.totals.sales, 500);
});

// ---------------------------------------------------------------------
// The two halves must share one window
// ---------------------------------------------------------------------

check('a fractional window is described as it is, not rounded up to reliable', () => {
  // The bug this guards: purchases cannot reach before the cutover, so
  // right now the real window is nine days. Asking for four weeks and
  // being given four weeks of sales against nine days of buying would
  // print a seventy per cent margin on every department and read as the
  // best month the store ever had.
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 10000 }],
    [{ department_id: '3', amount: 7000 }], NAMES, 1.3);
  assert.strictEqual(out.weeks, 1.3);
  assert.strictEqual(out.reliable, false);
  assert.ok(out.caution, 'a nine-day window must carry its caution');
});

// ---------------------------------------------------------------------
// Refusing to print a percentage it cannot stand behind
//
// With 30% of his buying uncoded and a nine-day window, meat came out at
// 74.5% and produce at -94.5%. Both are nonsense, and both are the kind
// that looks like news rather than like a fault -- he could believe meat
// was having a record month. A number on a screen outlives the sentence
// printed next to it, so the number goes, not just the confidence.
// ---------------------------------------------------------------------

check('percentages are withheld when most buying has no department', () => {
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 76775 }],
    [{ department_id: '3', amount: 19587 }],
    NAMES, 6, 180000);                 // long enough window, 10% coded
  assert.strictEqual(out.trustworthy, false);
  assert.strictEqual(find(out, '3').pct, null);
  assert.strictEqual(out.totals.comparable_pct, null);
  assert.ok(/of your buying has a department/.test(out.why_not));
  // The facts are still there. Only the derived figure is withheld.
  assert.strictEqual(find(out, '3').sales, 76775);
  assert.strictEqual(find(out, '3').purchases, 19587);
});

check('percentages are withheld on a short window even when fully coded', () => {
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 10000 }],
    [{ department_id: '3', amount: 7000 }], NAMES, 1.3, 0);
  assert.strictEqual(out.trustworthy, false);
  assert.strictEqual(find(out, '3').pct, null);
  assert.ok(/window is only/.test(out.why_not));
});

check('both faults at once are both named', () => {
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 10000 }],
    [{ department_id: '3', amount: 3000 }], NAMES, 1.3, 20000);
  assert.ok(/Two things first/.test(out.why_not));
  assert.ok(/week/.test(out.why_not) && /department/.test(out.why_not));
});

check('a long window with the buying coded does give percentages', () => {
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 300000 }],
    [{ department_id: '3', amount: 225000 }], NAMES, 5, 10000);
  assert.strictEqual(out.trustworthy, true);
  assert.strictEqual(out.why_not, null);
  assert.strictEqual(find(out, '3').pct, 25);
  assert.strictEqual(out.totals.comparable_pct, 25);
});

check('the coded share is reported, so the gap is visible', () => {
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 100 }],
    [{ department_id: '3', amount: 75 }], NAMES, 6, 25);
  assert.strictEqual(out.coded_share, 75);
  assert.strictEqual(out.uncoded_total, 25);
  // Exactly on the line counts as good enough.
  assert.strictEqual(out.trustworthy, true);
});

check('trustworthy needs BOTH conditions, never one', () => {
  assert.strictEqual(trustworthy(6, 0.9), true);
  assert.strictEqual(trustworthy(2, 0.9), false);
  assert.strictEqual(trustworthy(6, 0.4), false);
  assert.strictEqual(trustworthy(2, 0.4), false);
});

check('no buying at all does not read as fully coded', () => {
  // Nothing bought and nothing uncoded must not come out as 100% coded
  // and therefore trustworthy: there is simply nothing to compare.
  const out = byDepartment(
    [{ department_id: '3', net_sales_amount: 5000 }], [], NAMES, 6, 0);
  assert.strictEqual(out.trustworthy, false);
  assert.strictEqual(find(out, '3').pct, null);
});

console.log('\nmargin: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);

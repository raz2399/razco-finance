// Reading the product lines off a delivery invoice.
//
// Lines exist so the system can notice a case price going up, which is
// the quietest way a grocery store loses margin: the wholesaler adds a
// few cents, the invoice total looks normal because the order was a
// different size, the shelf price never moves, and nobody finds out.
//
// That makes a wrong line worse than a missing one. A missing line shows
// up as a gap; a wrong one becomes a price the watch will act on, and
// an alert about a rise that never happened teaches him to ignore the
// alerts. So most of this is about what gets marked or thrown away.

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { linesFrom, linesCover, adds_up, onlyRealColumns } =
  require(path.join(ROOT, 'functions', 'lib', 'lines.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const INV = 'inv-1';
const read = (lines, rest) => linesFrom(Object.assign({ lines: lines }, rest || {}), INV);

// ---------------------------------------------------------------------
// The ordinary case
// ---------------------------------------------------------------------

check('a clean line comes through whole', () => {
  const r = read([{ code: '40881', description: 'ROMA TOMATO', pack: '25 LB',
    quantity: 4, unit_cost: 18.5, line_total: 74 }]);
  assert.strictEqual(r.kept, 1);
  const l = r.lines[0];
  assert.strictEqual(l.code, '40881');
  assert.strictEqual(l.pack, '25 LB');
  assert.strictEqual(l.quantity, 4);
  assert.strictEqual(l.unit_cost, 18.5);
  assert.strictEqual(l.line_total, 74);
  assert.strictEqual(l.figures_disagree, false);
  assert.strictEqual(l.line_no, 1);
  assert.strictEqual(l.invoice_id, INV);
});

check('money arrives with symbols and commas and still parses', () => {
  const r = read([{ description: 'SUGAR', quantity: '10', unit_cost: '$1,234.50',
    line_total: '$12,345.00' }]);
  assert.strictEqual(r.lines[0].unit_cost, 1234.5);
  assert.strictEqual(r.lines[0].line_total, 12345);
  assert.strictEqual(r.lines[0].figures_disagree, false);
});

check('lines keep the order they were printed in', () => {
  const r = read([{ description: 'A', line_total: 1 }, { description: 'B', line_total: 2 },
    { description: 'C', line_total: 3 }]);
  assert.deepStrictEqual(r.lines.map((l) => l.line_no), [1, 2, 3]);
  assert.deepStrictEqual(r.lines.map((l) => l.description), ['A', 'B', 'C']);
});

// ---------------------------------------------------------------------
// Arithmetic that does not hold up
// ---------------------------------------------------------------------

check('a line whose figures disagree is kept but marked', () => {
  // 4 x 18.50 is 74.00, not 92.50. One of the three was misread and
  // there is no way to know which. The product was still delivered, so
  // the line stays; the price is what cannot be trusted.
  const r = read([{ description: 'ROMA TOMATO', quantity: 4, unit_cost: 18.5,
    line_total: 92.5 }]);
  assert.strictEqual(r.kept, 1);
  assert.strictEqual(r.suspect, 1);
  assert.strictEqual(r.lines[0].figures_disagree, true);
  assert.strictEqual(r.lines[0].line_total, 92.5, 'the figures are kept as read');
});

check('a cent of rounding is not a disagreement', () => {
  // 3 x 4.333 is 12.999. Wholesalers round these in their own direction.
  const r = read([{ description: 'X', quantity: 3, unit_cost: 4.333, line_total: 13 }]);
  assert.strictEqual(r.lines[0].figures_disagree, false);
  assert.strictEqual(r.suspect, 0);
});

check('a missing total is worked out, never a missing price', () => {
  // Quantity times unit cost is arithmetic. Dividing a total by a
  // quantity to invent a unit price is a guess, and it is exactly the
  // number the price watch would then compare -- so it is not done.
  const got = read([{ description: 'X', quantity: 5, unit_cost: 2 }]);
  assert.strictEqual(got.lines[0].line_total, 10);

  const noPrice = read([{ description: 'Y', quantity: 5, line_total: 10 }]);
  assert.strictEqual(noPrice.lines[0].unit_cost, null);
});

check('two of three missing means no verdict, not a failed one', () => {
  const r = read([{ description: 'X', line_total: 40 }]);
  assert.strictEqual(r.lines[0].figures_disagree, false);
  assert.strictEqual(r.suspect, 0);
  assert.strictEqual(adds_up(null, null, 40), null);
});

// ---------------------------------------------------------------------
// Rows that are not lines
// ---------------------------------------------------------------------

check('an empty row is thrown away', () => {
  const r = read([{ description: null, code: null, quantity: null,
    unit_cost: null, line_total: null }]);
  assert.strictEqual(r.kept, 0);
  assert.strictEqual(r.dropped, 1);
});

check('a row with only a quantity is not a product', () => {
  // A ruled-off row or a stray column the reader picked up.
  const r = read([{ quantity: 3 }]);
  assert.strictEqual(r.kept, 0);
});

check('a row with money but no name is kept', () => {
  // An unreadable description on a real charge: worth keeping, because
  // the money is part of what the invoice comes to.
  const r = read([{ line_total: 55.25 }]);
  assert.strictEqual(r.kept, 1);
  assert.strictEqual(r.lines[0].description, null);
});

check('no lines at all is not an error', () => {
  const r = linesFrom({ total: 400 }, INV);
  assert.strictEqual(r.kept, 0);
  assert.strictEqual(r.dropped, 0);
  assert.deepStrictEqual(r.lines, []);
});

check('blank strings become null, not empty text', () => {
  const r = read([{ code: '   ', description: 'X', pack: '', line_total: 5 }]);
  assert.strictEqual(r.lines[0].code, null);
  assert.strictEqual(r.lines[0].pack, null);
});

// ---------------------------------------------------------------------
// Do the lines account for the bill?
// ---------------------------------------------------------------------

check('lines that come to the subtotal are covered', () => {
  const r = read([{ description: 'A', line_total: 60 }, { description: 'B', line_total: 40 }]);
  const c = linesCover(r.lines, { subtotal: 100, total: 108.5 });
  assert.strictEqual(c.covered, true);
  assert.strictEqual(c.sum, 100);
});

check('half an invoice is NOT covered', () => {
  // The failure that would poison the price watch: a second page the
  // reader never saw. This month's half against last month's whole
  // reads as an enormous saving.
  const r = read([{ description: 'A', line_total: 50 }]);
  const c = linesCover(r.lines, { subtotal: 1000 });
  assert.strictEqual(c.covered, false);
  assert.ok(c.share < 0.1);
});

check('tax read in as a line is tolerated, not failed', () => {
  const r = read([{ description: 'A', line_total: 100 },
    { description: 'CA TAX', line_total: 8 }]);
  const c = linesCover(r.lines, { subtotal: 100, total: 108 });
  assert.strictEqual(c.covered, true);
});

check('it falls back to the total when there is no subtotal', () => {
  const r = read([{ description: 'A', line_total: 99 }]);
  const c = linesCover(r.lines, { total: 100 });
  assert.strictEqual(c.checked, true);
  assert.strictEqual(c.covered, true);
});

check('nothing to compare against gives no verdict', () => {
  const r = read([{ description: 'A', line_total: 99 }]);
  const c = linesCover(r.lines, {});
  assert.strictEqual(c.checked, false);
  assert.strictEqual(c.covered, null);
});

check('no lines gives no verdict either', () => {
  const c = linesCover([], { subtotal: 500 });
  assert.strictEqual(c.checked, false);
});

// ---------------------------------------------------------------------
// Writing only what the table has
// ---------------------------------------------------------------------

check('columns the table does not have are left off', () => {
  // code and pack arrive before the migration that adds them. A row
  // carrying an unknown column is refused whole by Postgres, so the
  // whole invoice would lose its lines over a column that is only
  // nice to have.
  const row = { invoice_id: 'i', description: 'X', code: '40881', pack: '25 LB',
    line_total: 5 };
  const narrow = onlyRealColumns(row,
    { invoice_id: 1, description: 1, line_total: 1 });
  assert.deepStrictEqual(Object.keys(narrow).sort(),
    ['description', 'invoice_id', 'line_total']);
  assert.strictEqual(narrow.code, undefined);
});

check('it survives being handed no column list at all', () => {
  assert.deepStrictEqual(onlyRealColumns({ a: 1 }, null), {});
});

console.log('\nlines: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);

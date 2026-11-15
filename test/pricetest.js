// Noticing a case price go up.
//
// The leak: a wholesaler adds forty cents, the invoice total looks
// ordinary because the order was a different size, the shelf price never
// moves, and the margin on that item goes quietly for months.
//
// The danger in catching it: an alert he cannot trust is worse than no
// alert. After the third false one he stops reading them, and the true
// one goes past with the rest. So nearly every case here is a comparison
// the watch must REFUSE to make — different vendor, different pack,
// different product, a misread line, a move too small to act on.

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { priceMoves, summarise, keyOf, usable } =
  require(path.join(ROOT, 'functions', 'lib', 'pricewatch.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

let n = 0;
const line = (over) => Object.assign({
  invoice_id: 'inv-' + (++n),
  invoice_date: '2026-11-01',
  vendor_id: 'v-ok',
  vendor: 'OK PRODUCE',
  code: '40881',
  description: 'ROMA TOMATO 25LB',
  pack: '25 LB',
  quantity: 4,
  unit_cost: 18.00,
  line_total: 72,
  figures_disagree: false,
}, over || {});

// ---------------------------------------------------------------------
// Catching the thing it is for
// ---------------------------------------------------------------------

check('a case price going up is reported', () => {
  const m = priceMoves([
    line({ invoice_date: '2026-10-01', unit_cost: 18.00 }),
    line({ invoice_date: '2026-11-01', unit_cost: 19.50 }),
  ]);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].from, 18);
  assert.strictEqual(m[0].to, 19.5);
  assert.strictEqual(m[0].diff, 1.5);
  assert.strictEqual(m[0].direction, 'up');
  assert.ok(Math.abs(m[0].pct - 8.3) < 0.1, 'pct was ' + m[0].pct);
});

check('it says what the rise costs on a real delivery', () => {
  // The number that makes it actionable: $1.50 a case on four cases.
  const m = priceMoves([
    line({ invoice_date: '2026-10-01', unit_cost: 18.00 }),
    line({ invoice_date: '2026-11-01', unit_cost: 19.50, quantity: 4 }),
  ]);
  assert.strictEqual(m[0].cost_per_delivery, 6);
});

check('a price coming down is reported too', () => {
  const m = priceMoves([
    line({ invoice_date: '2026-10-01', unit_cost: 20.00 }),
    line({ invoice_date: '2026-11-01', unit_cost: 18.00 }),
  ]);
  assert.strictEqual(m[0].direction, 'down');
  assert.strictEqual(m[0].diff, -2);
});

check('only the two most recent deliveries are compared', () => {
  // Not the cheapest ever against today, which would report a rise
  // every time a one-off promotion ended.
  const m = priceMoves([
    line({ invoice_date: '2026-09-01', unit_cost: 10.00 }),
    line({ invoice_date: '2026-10-01', unit_cost: 18.00 }),
    line({ invoice_date: '2026-11-01', unit_cost: 19.50 }),
  ]);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].from, 18);
  assert.strictEqual(m[0].deliveries, 3);
});

check('the costliest change comes first, not the biggest percentage', () => {
  // A 5% rise on something bought by the pallet beats a 40% rise on one
  // box of a thing he buys twice a year.
  const m = priceMoves([
    line({ code: 'A', invoice_date: '2026-10-01', unit_cost: 100, quantity: 20 }),
    line({ code: 'A', invoice_date: '2026-11-01', unit_cost: 106, quantity: 20 }),
    line({ code: 'B', invoice_date: '2026-10-01', unit_cost: 5, quantity: 1 }),
    line({ code: 'B', invoice_date: '2026-11-01', unit_cost: 7, quantity: 1 }),
  ]);
  assert.strictEqual(m[0].code, 'A');
  assert.strictEqual(m[0].cost_per_delivery, 120);
});

// ---------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------

check('two different vendors are never compared', () => {
  // Two wholesalers charging different prices for the same tomatoes is
  // not a price rise, it is Tuesday.
  const m = priceMoves([
    line({ vendor_id: 'v-ok', invoice_date: '2026-10-01', unit_cost: 18 }),
    line({ vendor_id: 'v-other', invoice_date: '2026-11-01', unit_cost: 26 }),
  ]);
  assert.strictEqual(m.length, 0);
});

check('two different pack sizes are never compared', () => {
  // $18 for a 25 lb case and $18 for a 10 lb case is a huge rise that
  // would be reported as no change at all.
  const m = priceMoves([
    line({ pack: '25 LB', invoice_date: '2026-10-01', unit_cost: 18 }),
    line({ pack: '10 LB', invoice_date: '2026-11-01', unit_cost: 18 }),
  ]);
  assert.strictEqual(m.length, 0);
});

check('pack is matched despite spacing and case', () => {
  const m = priceMoves([
    line({ pack: '24/12 oz', invoice_date: '2026-10-01', unit_cost: 18 }),
    line({ pack: '24/12  OZ ', invoice_date: '2026-11-01', unit_cost: 20 }),
  ]);
  assert.strictEqual(m.length, 1);
});

check('a misread line is never a price', () => {
  // 4 x 18.00 is not 92.50, so one of the three was read wrong. A
  // fictional price makes a fictional alert.
  const m = priceMoves([
    line({ invoice_date: '2026-10-01', unit_cost: 18 }),
    line({ invoice_date: '2026-11-01', unit_cost: 23.5, figures_disagree: true }),
  ]);
  assert.strictEqual(m.length, 0);
  assert.strictEqual(usable(line({ figures_disagree: true })), false);
});

check('a line with no unit price is skipped', () => {
  const m = priceMoves([
    line({ invoice_date: '2026-10-01', unit_cost: 18 }),
    line({ invoice_date: '2026-11-01', unit_cost: null }),
  ]);
  assert.strictEqual(m.length, 0);
});

check('a short description is not an identity', () => {
  // Without a vendor code, "TOM" would match half the produce list and
  // invent a price change out of two different products.
  assert.strictEqual(keyOf({ description: 'TOM', pack: '25 LB' }, 'v'), null);
  assert.ok(keyOf({ description: 'ROMA TOMATO 25LB', pack: '25 LB' }, 'v'));
});

check('a vendor code beats the description', () => {
  // The same product abbreviated two ways on two invoices still matches.
  const m = priceMoves([
    line({ code: '40881', description: 'ROMA TOM 25#', invoice_date: '2026-10-01', unit_cost: 18 }),
    line({ code: '40881', description: 'TOMATO ROMA 25LB CS', invoice_date: '2026-11-01', unit_cost: 20 }),
  ]);
  assert.strictEqual(m.length, 1);
});

check('the same invoice scanned twice is not a price change', () => {
  const m = priceMoves([
    Object.assign(line({ unit_cost: 18 }), { invoice_id: 'same' }),
    Object.assign(line({ unit_cost: 22 }), { invoice_id: 'same' }),
  ]);
  assert.strictEqual(m.length, 0);
});

check('two deliveries on one day are not compared', () => {
  // Two trucks the same morning at different prices is a billing
  // question, not a price move, and reporting it as one is noise.
  const m = priceMoves([
    line({ invoice_date: '2026-11-01', unit_cost: 18 }),
    line({ invoice_date: '2026-11-01', unit_cost: 20 }),
  ]);
  assert.strictEqual(m.length, 0);
});

check('a small percentage is ignored', () => {
  const m = priceMoves([
    line({ invoice_date: '2026-10-01', unit_cost: 100 }),
    line({ invoice_date: '2026-11-01', unit_cost: 102 }),
  ]);
  assert.strictEqual(m.length, 0, '2% is noise');
});

check('a big percentage of a tiny number is ignored', () => {
  // 20 cents to 24 is a 20% rise and worth nobody's morning.
  const m = priceMoves([
    line({ invoice_date: '2026-10-01', unit_cost: 0.20 }),
    line({ invoice_date: '2026-11-01', unit_cost: 0.24 }),
  ]);
  assert.strictEqual(m.length, 0);
});

check('an item bought only once says nothing', () => {
  assert.strictEqual(priceMoves([line({})]).length, 0);
});

check('an unchanged price is not reported', () => {
  const m = priceMoves([
    line({ invoice_date: '2026-10-01', unit_cost: 18 }),
    line({ invoice_date: '2026-11-01', unit_cost: 18 }),
  ]);
  assert.strictEqual(m.length, 0);
});

check('no lines at all is handled', () => {
  assert.deepStrictEqual(priceMoves([]), []);
});

// ---------------------------------------------------------------------
// What he reads
// ---------------------------------------------------------------------

check('the summary counts both directions and the money', () => {
  const m = priceMoves([
    line({ code: 'A', invoice_date: '2026-10-01', unit_cost: 10, quantity: 10 }),
    line({ code: 'A', invoice_date: '2026-11-01', unit_cost: 12, quantity: 10 }),
    line({ code: 'B', invoice_date: '2026-10-01', unit_cost: 20, quantity: 1 }),
    line({ code: 'B', invoice_date: '2026-11-01', unit_cost: 17, quantity: 1 }),
  ]);
  const s = summarise(m);
  assert.ok(/1 item up/.test(s), s);
  assert.ok(/\$20\.00 more/.test(s), s);
  assert.ok(/1 down/.test(s), s);
  assert.ok(/\$3\.00/.test(s), s);
});

check('nothing moving says so plainly', () => {
  assert.ok(/No case price has moved/.test(summarise([])));
});

console.log('\nprice: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);

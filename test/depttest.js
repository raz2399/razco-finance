// Which department a vendor's deliveries belong to.
//
// Getting this wrong does not look wrong. It moves margin out of one
// department and into another, and both figures read as perfectly
// normal -- a meat margin of 22% and a grocery margin of 26% look like
// a good month whichever department the money really came from. There is
// no screen anywhere that would catch it.
//
// So the cases that matter here are the refusals. A guesser that answers
// every name is worse than one that answers half of them and says so,
// because the half it invents is indistinguishable from the half it knew.

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { guessDept, proposeFor, squash, DEPT } =
  require(path.join(ROOT, 'functions', 'lib', 'deptguess.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const at = (name) => {
  const g = guessDept(name);
  return g ? g.department_id : null;
};

// ---------------------------------------------------------------------
// His real vendors, by name
// ---------------------------------------------------------------------

check('produce houses read as produce', () => {
  assert.strictEqual(at('OK PRODUCE'), DEPT.PRODUCE);
  assert.strictEqual(at('GREEN VALLEY PRODUCE'), DEPT.PRODUCE);
  assert.strictEqual(at('PRODUCERS'), DEPT.PRODUCE);
  assert.strictEqual(at('ROSEMARY FARM'), DEPT.PRODUCE);
});

check('seafood and ranches read as meat', () => {
  assert.strictEqual(at('M & J Seafood Co., Inc.'), DEPT.MEAT);
  assert.strictEqual(at('HARRIS RANCH'), DEPT.MEAT);
});

check('tortilla makers read as tortillas, not bakery', () => {
  // He sells tortillas as their own department doing $14k a month. A
  // tortilla factory landing in bakery would hide that department's
  // margin inside a different one.
  assert.strictEqual(at('LA ROSA TORTILLA FACTORY INC'), DEPT.TORTILLAS);
  assert.strictEqual(at('mission foods'), DEPT.TORTILLAS);
  assert.strictEqual(at('GRUMA CORPORATION dba Mission'), DEPT.TORTILLAS);
});

check('bakeries read as bakery, misspelling and all', () => {
  // His own vendor list spells it "Bakires". The guesser answers to the
  // spelling in his books, not the correct one.
  assert.strictEqual(at('Bimbo Bakires USA'), DEPT.BAKERY);
  assert.strictEqual(at('Bakemark'), DEPT.BAKERY);
});

check('beverage distributors read as soda', () => {
  assert.strictEqual(at('VALLEY WIDE BEVERAGE'), DEPT.SODA);
  assert.strictEqual(at('BUENO BEVERAGE COMPNY'), DEPT.SODA);
});

// ---------------------------------------------------------------------
// The refusals -- the point of the thing
// ---------------------------------------------------------------------

check('a full-line distributor is NOT guessed', () => {
  // These are his biggest vendors: $95k, $20k, $11k. Each delivers
  // across several departments, so any single answer is wrong, and the
  // one most likely to be picked -- grocery, the biggest -- would quietly
  // absorb the cost of meat and produce. He names these himself.
  assert.strictEqual(at('pac agri foods'), null);
  assert.strictEqual(at('Sysco'), null);
  assert.strictEqual(at('L&H FOOD CO'), null);
  assert.strictEqual(at('FRESNO WHOLESALE INC'), null);
});

check('a name that says nothing gets no answer', () => {
  assert.strictEqual(at('NATIONAL SALES CORPORATION'), null);
  assert.strictEqual(at('Dona G Sales'), null);
  assert.strictEqual(at('AQ SALES WHOLESALE'), null);
  assert.strictEqual(at('GOLDEN VALLEY DISTRIBUTION'), null);
  assert.strictEqual(at('PEREZ DISTRIBUTING FRESNO INC'), null);
  assert.strictEqual(at('CARGIL'), null);
});

check('"WHOLESALE" and "DISTRIBUTING" are never evidence', () => {
  // Every third vendor in the trade is called one of these. If they
  // counted, nearly everything would be coded, nearly all of it wrongly.
  assert.strictEqual(at('ROPAMEX WHOLESALE INC'), null);
  assert.strictEqual(at('GUMMY BEAR DISTRIBUTIONS'), null);
});

check('empty and junk names give nothing', () => {
  assert.strictEqual(guessDept(''), null);
  assert.strictEqual(guessDept(null), null);
  assert.strictEqual(guessDept('   ---   '), null);
});

check('a word inside another word is not a match', () => {
  // The failure that would be invisible: "PANADERIA" is not "PAN",
  // "BEERY FARMS" must not read as beer, "DELICIOUS" is not "DELI".
  assert.notStrictEqual(at('DELICIOUS SNACKS CO'), DEPT.DELI);
  assert.notStrictEqual(at('SMOKEHOUSE DELIGHTS'), DEPT.TOBACCO);
});

check('every answer carries the word that caused it', () => {
  // Without the reason the proposal is unauditable: he would be agreeing
  // to a department with no way to see why it was offered.
  const g = guessDept('OK PRODUCE');
  assert.strictEqual(g.because, 'PRODUCE');
  assert.ok(String(g.because).length > 2);
});

// ---------------------------------------------------------------------
// Proposing against the categories that actually exist
// ---------------------------------------------------------------------

const CATS = [
  { category_id: 1, name: 'Merchandise - not yet assigned', department_id: null },
  { category_id: 20, name: 'Grocery', department_id: '1' },
  { category_id: 22, name: 'Meat', department_id: '3' },
  { category_id: 24, name: 'Produce', department_id: '6' },
  { category_id: 30, name: 'Overheads', department_id: null },
];

check('a vendor already coded is left alone', () => {
  const out = proposeFor(
    [{ vendor_id: 'v1', name: 'OK PRODUCE', default_category_id: 24 }], CATS);
  assert.strictEqual(out.length, 0);
});

check('a vendor parked in the old merchandise bucket IS proposed', () => {
  // Category 1 means nobody ever said what the vendor sells. Treating
  // it as settled would leave $280,000 of buying in one lump for ever.
  const out = proposeFor(
    [{ vendor_id: 'v1', name: 'OK PRODUCE', default_category_id: 1 }], CATS);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category_id, 24);
});

check('nothing is proposed for a department with no cost category', () => {
  // Tortillas has no category in this set. Proposing one would hand the
  // browser a category_id that does not exist.
  const out = proposeFor(
    [{ vendor_id: 'v1', name: 'LA ROSA TORTILLA FACTORY INC' }], CATS);
  assert.strictEqual(out.length, 0);
});

check('the proposal carries the vendor, category and reason together', () => {
  const out = proposeFor([{ vendor_id: 'v9', name: 'HARRIS RANCH' }], CATS);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].vendor_id, 'v9');
  assert.strictEqual(out[0].category, 'Meat');
  assert.strictEqual(out[0].department_id, '3');
  assert.strictEqual(out[0].because, 'RANCH');
});

check('proposing twice over the same list gives the same answer', () => {
  // The accept path re-proposes on the server rather than trusting the
  // browser, so the two passes have to agree or a press would write
  // something he was never shown.
  const vs = [
    { vendor_id: 'a', name: 'OK PRODUCE' },
    { vendor_id: 'b', name: 'Sysco' },
    { vendor_id: 'c', name: 'M & J Seafood Co., Inc.' },
  ];
  assert.deepStrictEqual(proposeFor(vs, CATS), proposeFor(vs, CATS));
});

check('squash leaves nothing but letters, digits and single spaces', () => {
  assert.strictEqual(squash('M & J  Seafood Co., Inc.'), 'M J SEAFOOD CO INC');
});

console.log('\ndept: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);

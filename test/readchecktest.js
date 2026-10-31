// Judging a photographed check.
//
// A check states its amount twice -- the numeric box and the words on
// the long line -- and that second opinion is the entire reason a
// photographed check can be trusted more than a photographed invoice.
//
// The way to waste it is to ask the model "do these two agree?". If it
// misread one of them it will say yes, and the check meant to catch a
// misreading has been handed to the thing doing the misreading. Silent,
// and indistinguishable from success.
//
// So both amounts come back separately and the comparison is arithmetic.
// These tests are about that, and about what happens when it fails.

const assert = require('assert');
const path = require('path');
const { judge, wordsMatchFigure } =
  require(path.join(__dirname, '..', 'functions', 'lib', 'readcheck.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('\nthe two amounts');

check('both read and agreeing is verified', () => {
  const v = judge({
    amount_numeric: 1234.5,
    amount_written: 'One Thousand Two Hundred Thirty-Four and 50/100',
  });
  assert.strictEqual(v.trust, 'verified');
  assert.strictEqual(v.amount, 1234.5);
  assert.strictEqual(v.needs_eyes, false);
});

check('untidy spacing and case still agree', () => {
  // It comes off a photograph, not out of a database.
  assert.strictEqual(wordsMatchFigure(
    'one thousand two hundred thirty four and 50 / 100', 1234.5), true);
  assert.strictEqual(wordsMatchFigure(
    'ONE  THOUSAND   TWO HUNDRED THIRTY-FOUR AND 50/100', 1234.5), true);
});

check('a disagreement fills in NOTHING', () => {
  // The whole point. A figure on screen is a figure somebody saves
  // without looking.
  const v = judge({
    amount_numeric: 1500,
    amount_written: 'One Thousand Eight Hundred and 00/100',
  });
  assert.strictEqual(v.trust, 'conflict');
  assert.strictEqual(v.amount, null, 'it filled in an amount it cannot vouch for');
  assert.strictEqual(v.needs_eyes, true);
});

check('and says both figures so a person can see which is right', () => {
  const v = judge({
    amount_numeric: 1500,
    amount_written: 'One Thousand Eight Hundred and 00/100',
  });
  const said = v.why.join(' ');
  assert.ok(said.indexOf('1500.00') > -1, said);
  assert.ok(said.indexOf('One Thousand Eight Hundred') > -1, said);
});

check('a cent of difference is a disagreement', () => {
  const v = judge({
    amount_numeric: 1234.51,
    amount_written: 'One Thousand Two Hundred Thirty-Four and 50/100',
  });
  assert.strictEqual(v.trust, 'conflict');
  assert.strictEqual(v.amount, null);
});

check('the hundreds are not quietly dropped', () => {
  // 1234.50 against "Two Hundred Thirty-Four and 50/100" -- a thousand
  // dollars apart, and the kind of misread that looks plausible.
  const v = judge({
    amount_numeric: 1234.5,
    amount_written: 'Two Hundred Thirty-Four and 50/100',
  });
  assert.strictEqual(v.trust, 'conflict');
});

console.log('\na stub, which has only one');

check('one amount is usable but always needs eyes', () => {
  const v = judge({ amount_numeric: 400, amount_written: null, is_stub: true });
  assert.strictEqual(v.trust, 'single');
  assert.strictEqual(v.amount, 400, 'a stub is still worth filling in');
  assert.strictEqual(v.needs_eyes, true, 'but never saved without being looked at');
  assert.ok(v.why.join(' ').indexOf('stub') > -1);
});

check('a check where only one amount was legible is treated the same', () => {
  const v = judge({ amount_numeric: 400, amount_written: null, is_stub: false });
  assert.strictEqual(v.trust, 'single');
  assert.strictEqual(v.needs_eyes, true);
  assert.ok(v.why.join(' ').indexOf('nothing to check it against') > -1);
});

check('handwriting is called out even when the two agree', () => {
  const v = judge({
    amount_numeric: 400,
    amount_written: 'Four Hundred and 00/100',
    handwritten: true,
  });
  assert.strictEqual(v.trust, 'verified');
  assert.ok(v.why.join(' ').toLowerCase().indexOf('handwritten') > -1);
});

console.log('\nnothing readable');

check('no amount at all is a conflict, not a zero', () => {
  const v = judge({ amount_numeric: null, amount_written: null });
  assert.strictEqual(v.trust, 'conflict');
  assert.strictEqual(v.amount, null);
  assert.notStrictEqual(v.amount, 0, 'a check for nothing is not a check for zero');
});

check('words we cannot write ourselves are never vouched for', () => {
  // If the written line says something our own writer cannot produce,
  // we do not claim it matches.
  assert.strictEqual(wordsMatchFigure('something unreadable', 400), false);
  assert.strictEqual(wordsMatchFigure('Four Hundred and 00/100', -5), false);
});

check('a missing written line is "nothing to compare", not a mismatch', () => {
  assert.strictEqual(wordsMatchFigure(null, 400), null);
  assert.strictEqual(wordsMatchFigure('', 400), null);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

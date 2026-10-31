// The written amount on a check.
//
// On a US check the written line is the legal amount: where it and the
// numeric box disagree, the bank follows the words (UCC 3-114). A bug
// here does not make a check look wrong. It makes a check that pays the
// wrong amount, correctly, with the bank entirely in the right.
//
// So this suite is paranoid on purpose, and most of it is about the
// cents -- which is where every quiet version of this bug lives.

const assert = require('assert');
const path = require('path');
const { amountInWords, amountInFigures, fill } =
  require(path.join(__dirname, '..', 'functions', 'lib', 'checkwords.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const eq = (amount, expected) => check(
  String(amount) + '  ->  ' + expected,
  () => assert.strictEqual(amountInWords(amount), expected));

console.log('\nthe written line');

// ---- the cents, where the money gets lost ----------------------------
eq(1234.5, 'One Thousand Two Hundred Thirty-Four and 50/100');
eq(1234.05, 'One Thousand Two Hundred Thirty-Four and 05/100');
eq(0.99, 'Zero and 99/100');
eq(0.09, 'Zero and 09/100');
eq(0, 'Zero and 00/100');
eq(100, 'One Hundred and 00/100');

check('a half cent is rounded once, not twice', () => {
  // The words and the figures must come from the same rounding, or a
  // check can be printed whose two amounts disagree by a cent -- and the
  // bank would pay the words.
  const odd = 1234.567;
  assert.strictEqual(amountInWords(odd), 'One Thousand Two Hundred Thirty-Four and 57/100');
  assert.strictEqual(amountInFigures(odd), '**1,234.57');
});

check('the words and the figures never disagree', () => {
  for (let i = 0; i < 2000; i++) {
    const amt = Math.round(Math.random() * 10000000) / 100;
    const words = amountInWords(amt);
    const figs = amountInFigures(amt);
    const centsFromFigs = figs.replace(/[^\d.]/g, '');
    const wordCents = words.match(/and (\d\d)\/100$/)[1];
    const figCents = centsFromFigs.split('.')[1];
    assert.strictEqual(wordCents, figCents,
      amt + ': words say ' + wordCents + ', box says ' + figCents);
  }
});

// ---- the scale ------------------------------------------------------
console.log('\nsizes');
eq(1, 'One and 00/100');
eq(19, 'Nineteen and 00/100');
eq(20, 'Twenty and 00/100');
eq(21, 'Twenty-One and 00/100');
eq(90, 'Ninety and 00/100');
eq(101, 'One Hundred One and 00/100');
eq(999, 'Nine Hundred Ninety-Nine and 00/100');
eq(1000, 'One Thousand and 00/100');
eq(1001, 'One Thousand One and 00/100');
eq(10000, 'Ten Thousand and 00/100');
eq(100000, 'One Hundred Thousand and 00/100');
eq(1000000, 'One Million and 00/100');
eq(1000000.01, 'One Million and 01/100');
eq(24272.8, 'Twenty-Four Thousand Two Hundred Seventy-Two and 80/100');
eq(708705.19, 'Seven Hundred Eight Thousand Seven Hundred Five and 19/100');

check('a thousand with nothing in the hundreds reads right', () => {
  // "One Thousand Twelve", not "One Thousand and Twelve" or
  // "One Thousand Zero Hundred Twelve".
  assert.strictEqual(amountInWords(1012), 'One Thousand Twelve and 00/100');
  assert.strictEqual(amountInWords(1000012), 'One Million Twelve and 00/100');
});

// ---- the refusals ---------------------------------------------------
console.log('\nwhat it refuses to write');

check('a negative amount is refused, not printed as positive', () => {
  assert.strictEqual(amountInWords(-5), null);
  assert.strictEqual(amountInFigures(-5), null);
});

check('nonsense is refused', () => {
  assert.strictEqual(amountInWords('abc'), null);
  assert.strictEqual(amountInWords(NaN), null);
  assert.strictEqual(amountInWords(Infinity), null);
  assert.strictEqual(amountInWords(undefined), null);
});

check('an amount too large to write is refused', () => {
  // Better a refused check than one whose written line is incomplete.
  assert.strictEqual(amountInWords(1e13), null);
});

// ---- the protection -------------------------------------------------
console.log('\nthe filler that stops it being altered');

check('the written line is filled to the end', () => {
  const line = fill(amountInWords(400), 60);
  assert.strictEqual(line.length, 60);
  assert.ok(/\*{5,}$/.test(line), 'should end in asterisks');
  assert.ok(line.indexOf('Four Hundred and 00/100') === 0);
});

check('a long amount is not truncated to make it fit', () => {
  const words = amountInWords(708705.19);
  const line = fill(words, 20);
  assert.ok(line.indexOf(words) === 0, 'the amount must survive intact');
  assert.strictEqual(line, words);
});

check('the numeric box is protected too', () => {
  assert.strictEqual(amountInFigures(400), '**400.00');
  assert.strictEqual(amountInFigures(1234.5), '**1,234.50');
  assert.strictEqual(amountInFigures(1000000), '**1,000,000.00');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

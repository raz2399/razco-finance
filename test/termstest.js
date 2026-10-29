// Due dates, and the refusal to invent one.
//
// 251 of Razco's 255 vendors have no terms on file. The old code met
// that with `termsDays || 30` and produced a confident date a month out,
// which then drove "due this week" -- the figure Raz actually pays bills
// from. So nearly every due date on the screen was a number nobody had
// agreed to.
//
// It is wrong in both directions at once. A COD vendor looks like it can
// wait a month. A vendor on net 7 sits quietly until it is three weeks
// late. And neither looks wrong, because a date always looks like a fact.
//
// These tests exist so that behaviour cannot come back.

const assert = require('assert');
const path = require('path');
const Module = require('module');
require('./stub-guard');

// ap-calendar builds a Supabase client at require time.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'k';

const ROOT = path.join(__dirname, '..');
const src = require('fs').readFileSync(
  path.join(ROOT, 'functions', 'ap-calendar.js'), 'utf8');

// The two functions under test are module-private, so they are lifted
// out and evaluated on their own rather than exported purely for a test.
function lift(name) {
  const re = new RegExp('function ' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not find ' + name + ' in ap-calendar.js');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '; return ' + name + ';')();
}

const calculateDueDate = lift('calculateDueDate');
const getAgeStatus = lift('getAgeStatus');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('\ndue dates');

check('no terms at all means NO due date, not thirty days', () => {
  assert.strictEqual(calculateDueDate('2026-10-01', null, null), null);
  assert.strictEqual(calculateDueDate('2026-10-01', undefined, undefined), null);
  assert.strictEqual(calculateDueDate('2026-10-01', '', null), null);
});

check('an unrecognised terms code with no days is still null', () => {
  assert.strictEqual(calculateDueDate('2026-10-01', 'whenever', null), null);
});

check('an unrecognised terms code WITH days uses the days', () => {
  // The day count is real even if the code is not one we know.
  assert.strictEqual(calculateDueDate('2026-10-01', 'odd-code', 14), '2026-10-15');
});

check('net 15 is fifteen days', () => {
  assert.strictEqual(calculateDueDate('2026-10-01', 'net15', 15), '2026-10-16');
});

check('cod is the same day', () => {
  assert.strictEqual(calculateDueDate('2026-10-01', 'cod', 0), '2026-10-01');
});

check('a weekend due date moves back to the Friday', () => {
  // 2026-10-03 is a Saturday; 2026-10-04 a Sunday.
  assert.strictEqual(calculateDueDate('2026-10-01', 'net15', 2), '2026-10-02');
  const sat = calculateDueDate('2026-09-28', 'net15', 5);  // 2026-10-03, Sat
  assert.strictEqual(sat, '2026-10-02', 'Saturday should fall back to Friday');
  const sun = calculateDueDate('2026-09-28', 'net15', 6);  // 2026-10-04, Sun
  assert.strictEqual(sun, '2026-10-02', 'Sunday should fall back to Friday');
});

console.log('\nageing');

check('an unknown due date is not "upcoming"', () => {
  // The bug this guards: filing an unknown bill under things that are
  // fine. It is not fine, it is unknown, and those are different.
  assert.strictEqual(getAgeStatus(null, '2026-10-29'), 'terms_unknown');
  assert.notStrictEqual(getAgeStatus(null, '2026-10-29'), 'upcoming');
});

check('overdue is still overdue', () => {
  assert.strictEqual(getAgeStatus('2026-10-01', '2026-10-29'), 'overdue_30');
  assert.strictEqual(getAgeStatus('2026-10-27', '2026-10-29'), 'overdue_5');
  assert.strictEqual(getAgeStatus('2026-11-10', '2026-10-29'), 'upcoming');
});

check('terms_unknown does not read as overdue', () => {
  // is_overdue is computed as indexOf('overdue') === 0 downstream.
  const s = getAgeStatus(null, '2026-10-29');
  assert.strictEqual(s.indexOf('overdue') === 0, false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

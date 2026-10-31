// The print link, which is the one piece of this that a browser opens
// with no session behind it.
//
// The phone cannot print. iOS prints through Safari's share sheet, so
// the app has to hand the browser a URL -- and a browser opened with
// Linking.openURL carries no Authorization header.
//
// Both lazy answers are wrong. An unauthenticated page puts every check
// the store has written behind a guessable URL. The session token in the
// query string writes it into browser history, the iOS share sheet, and
// every log in between.
//
// So the link is signed, scoped to one run, and dead in ten minutes.
// These tests are about the ways that could fail open.

const assert = require('assert');
const path = require('path');

process.env.SUPABASE_SERVICE_KEY = 'a-test-signing-key';
const TOKEN = path.join(__dirname, '..', 'functions', 'lib', 'sheettoken.js');
const { mint, open, TEN_MINUTES } = require(TOKEN);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('\nthe print link');

check('a link it made, it reads back', () => {
  const claim = open(mint('store1', ['p-1', 'p-2']));
  assert.ok(claim, 'should open its own token');
  assert.strictEqual(claim.store_id, 'store1');
  assert.deepStrictEqual(claim.payment_ids, ['p-1', 'p-2']);
});

check('the payment list cannot be edited into a different run', () => {
  const t = mint('store1', ['p-1']);
  const forged = b64({ s: 'store1', p: ['p-1', 'p-999'], e: Date.now() + TEN_MINUTES })
    + '.' + t.split('.')[1];
  assert.strictEqual(open(forged), null, 'opened a token with a swapped payload');
});

check('another store cannot be substituted', () => {
  const t = mint('store1', ['p-1']);
  const forged = b64({ s: 'store2', p: ['p-1'], e: Date.now() + TEN_MINUTES })
    + '.' + t.split('.')[1];
  assert.strictEqual(open(forged), null);
});

check('a token signed with another key is refused', () => {
  const t = mint('store1', ['p-1']);
  process.env.SUPABASE_SERVICE_KEY = 'a-different-key';
  delete require.cache[require.resolve(TOKEN)];
  const other = require(TOKEN);
  assert.strictEqual(other.open(t), null, 'opened a token it did not sign');
  process.env.SUPABASE_SERVICE_KEY = 'a-test-signing-key';
  delete require.cache[require.resolve(TOKEN)];
});

check('an expired link is dead', () => {
  const fresh = require(TOKEN);
  const real = Date.now;
  const t = fresh.mint('store1', ['p-1']);
  try {
    Date.now = () => real() + TEN_MINUTES + 1000;
    assert.strictEqual(fresh.open(t), null, 'an expired link still opened');
  } finally { Date.now = real; }
});

check('a link just inside ten minutes still works', () => {
  const fresh = require(TOKEN);
  const real = Date.now;
  const t = fresh.mint('store1', ['p-1']);
  try {
    Date.now = () => real() + TEN_MINUTES - 2000;
    assert.ok(fresh.open(t), 'it expired early');
  } finally { Date.now = real; }
});

check('rubbish is refused rather than crashing', () => {
  const fresh = require(TOKEN);
  ['', null, undefined, 'nope', 'a.b', '....', 'eyJ9.x',
   Buffer.from('{}').toString('base64') + '.x'].forEach((bad) => {
    assert.strictEqual(fresh.open(bad), null, 'accepted ' + JSON.stringify(bad));
  });
});

check('a truncated signature is refused, not padded', () => {
  const fresh = require(TOKEN);
  const parts = fresh.mint('store1', ['p-1']).split('.');
  assert.strictEqual(fresh.open(parts[0] + '.' + parts[1].slice(0, 10)), null);
});

console.log('\nthe page itself');

const fs = require('fs');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'functions', 'check-sheet.js'), 'utf8');

check('it never asks for a session, and never caches', () => {
  // A browser opened from the app has no session, so requireUser here
  // would make the page unreachable -- the token IS the authorisation.
  assert.ok(SRC.indexOf('requireUser') === -1,
    'check-sheet must not require a session; the token is the authorisation');
  assert.ok(/no-store/.test(SRC), 'a page of checks must not be cached');
  assert.ok(/noindex/.test(SRC), 'and must not be indexed');
  assert.ok(/no-referrer/.test(SRC), 'the token must not leak through a referrer');
});

check('a bad link explains itself instead of showing nothing', () => {
  assert.ok(/expired/.test(SRC));
  assert.ok(/already numbered/.test(SRC),
    'it should say the checks are not lost, only the link');
});

check('it tells him to turn off fit-to-page', () => {
  // Scaling is the single thing that silently ruins a printed check.
  assert.ok(/fit to page|fit-to-page/i.test(SRC));
  assert.ok(/100%/.test(SRC));
});

check('the phone hands the link to the browser, it does not print itself', () => {
  const screen = fs.readFileSync(
    path.join(__dirname, '..', 'mobile', 'src', 'PrintChecksScreen.js'), 'utf8');
  assert.ok(/Linking\.openURL/.test(screen),
    'the phone has no printer; it opens the page in Safari');
  assert.ok(/sheet_url/.test(screen));
  // And it must not number anything before the last button.
  assert.ok(screen.indexOf('printChecks(') > screen.indexOf('function go'),
    'numbers are only handed out when he presses print');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

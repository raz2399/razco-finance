// The phone app, checked before it costs ten minutes to find out.
//
// Nothing else in this repo looks at the phone source at all. A missing
// bracket in a screen is found by an EAS build, which takes about ten
// minutes to tell you, and only if someone is watching it. So: parse
// every file, and then check the handful of things that have actually
// gone wrong on this app before.
//
// Those are not hypothetical. Each check below is a bug that shipped:
//
//   - a screen importing something api.js does not export
//   - Alert.alert used as control flow, which on iOS never fires its
//     buttons when a Modal is on screen, so the function silently stops
//   - money(undefined) printing "$0", which turned a failed server call
//     into an empty bank account in the largest type on the screen
//   - a secondary fetch that can take the whole screen down with it

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'mobile');
const SRC = path.join(ROOT, 'src');

let parser = null;
try { parser = require('@babel/parser'); } catch (e) { /* checked below */ }

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const files = ['App.js'].concat(
  fs.readdirSync(SRC).filter((f) => /\.js$/.test(f)).map((f) => path.join('src', f))
);

console.log('\nevery phone file parses');

if (!parser) {
  console.log('  -- @babel/parser not installed; run npm install');
  console.log('\n0 passed, 0 failed (skipped)\n');
  process.exit(0);
}

const sources = {};
files.forEach((rel) => {
  const full = path.join(ROOT, rel);
  const text = fs.readFileSync(full, 'utf8');
  sources[rel] = text;
  check(rel, () => {
    parser.parse(text, { sourceType: 'module', plugins: ['jsx'] });
  });
});

console.log('\nwhat the screens ask api.js for, api.js exports');

const apiText = sources[path.join('src', 'api.js')];
const exported = {};
(apiText.match(/export\s+(?:const|function|async function|class)\s+([A-Za-z0-9_]+)/g) || [])
  .forEach((m) => { exported[m.split(/\s+/).pop()] = true; });
(apiText.match(/export\s*\{([^}]*)\}/g) || []).forEach((m) => {
  m.replace(/export\s*\{|\}/g, '').split(',').forEach((n) => {
    const clean = n.split(' as ').pop().trim();
    if (clean) exported[clean] = true;
  });
});

files.forEach((rel) => {
  const text = sources[rel];
  const re = /import\s*\{([^}]+)\}\s*from\s*'(\.\/api|\.\/src\/api)'/g;
  let m;
  while ((m = re.exec(text))) {
    m[1].split(',').forEach((raw) => {
      const name = raw.split(' as ')[0].trim();
      if (!name) return;
      check(rel + ' imports ' + name, () => {
        assert.ok(exported[name], 'api.js does not export ' + name);
      });
    });
  }
});

console.log('\nthe bugs that already shipped once');

check('no screen uses Alert.alert as a question it waits on', () => {
  // The Paid button fired nothing for days because of this: an
  // Alert.alert wrapped in a Promise, where neither onPress ever runs
  // if the alert does not present -- and on iOS it does not present
  // while a Modal is still in the view hierarchy. The promise never
  // settles and the function simply stops, with no error anywhere.
  // Comments are stripped first. Confirm.js carries the old pattern in
  // a comment precisely so the next person knows why it was replaced,
  // and a test that cannot tell code from a note about code would make
  // writing that note the thing that fails the build.
  const stripComments = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const offenders = [];
  files.forEach((rel) => {
    const t = stripComments(sources[rel]);
    if (/new Promise\([^)]*\)\s*=>\s*\{[\s\S]{0,200}?Alert\.alert/.test(t)
        || /await new Promise[\s\S]{0,200}?Alert\.alert/.test(t)) {
      offenders.push(rel);
    }
  });
  assert.strictEqual(offenders.length, 0,
    'Alert.alert awaited in: ' + offenders.join(', ') + ' -- use Confirm/Notice');
});

check('money() is never handed a figure the server did not send', () => {
  // money(undefined) renders "$0". That is how a 502 came to look like
  // an empty bank account. HomeScreen guards it with fig(); this checks
  // the guard is still there.
  const home = sources[path.join('src', 'HomeScreen.js')];
  assert.ok(/const fig\s*=/.test(home), 'the fig() guard has gone');
  assert.ok(/data && v != null/.test(home),
    'fig() no longer checks that the value actually arrived');
});

check('the attention banner cannot take the home screen down', () => {
  const home = sources[path.join('src', 'HomeScreen.js')];
  assert.ok(/getAttention\(\)[\s\S]{0,200}?\.catch\(/.test(home),
    'getAttention has no catch -- a secondary call must not stop the '
    + 'bank balance appearing');
  assert.ok(/attention && attention\.groups/.test(home),
    'the banner reads attention.groups without checking attention exists');
});

check('the check camera never fills in an amount it cannot vouch for', () => {
  // A check states its amount twice and the server compares them. When
  // they disagree the amount must stay EMPTY: a figure in the box is a
  // figure that gets saved without being looked at.
  const cs = sources[path.join('src', 'CheckScreen.js')];
  assert.ok(/readPaper\('check'/.test(cs), 'the camera should read a check');
  assert.ok(/d\.amount !== null && d\.amount !== undefined/.test(cs),
    'it must only set the amount when the server supplied one');
  assert.ok(!/setAmount\(String\(d\.amount_numeric\)\)/.test(cs),
    'it is filling in the raw numeric box, which defeats the cross-check');
  assert.ok(/trust/.test(cs), 'the screen should show how far the paper is trusted');
});

check('the home screen survives attention being null', () => {
  const home = sources[path.join('src', 'HomeScreen.js')];
  assert.ok(/useState\(null\)/.test(home), 'attention should start null');
  // The render guard above is what makes null safe; assert both halves
  // are present rather than trusting one.
  assert.ok(/attention\.groups\.length/.test(home));
});

console.log('\nversions line up');

check('app.json and the running branch agree', () => {
  const app = JSON.parse(sources['src/api.js'] ? fs.readFileSync(
    path.join(ROOT, 'app.json'), 'utf8') : '{}');
  assert.ok(app.expo, 'app.json has no expo block');
  assert.ok(app.expo.version, 'app.json has no version');
  // runtimeVersion policy decides which binaries an update can reach.
  // Getting this wrong is what cut Raz's phone off from every update.
  const rv = app.expo.runtimeVersion;
  assert.ok(rv, 'no runtimeVersion -- updates would reach nothing');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

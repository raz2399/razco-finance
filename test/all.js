// Runs every suite. One command before any deploy.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUITES = ['es5', 'overtest', 'paint', 'matchtest', 'matcherlib', 'realbank', 'termstest', 'taxtest', 'mobiletest', 'upserttest', 'dupetest', 'wordstest', 'printtest', 'removetest', 'readchecktest', 'printlinktest', 'scantest', 'undefinedtest', 'settletest', 'closetest', 'brieftest', 'ingesttest', 'extracttest', 'correcttest', 'contracttest', 'daytest', 'parsetest', 'vendortest', 'plaidtest', 'authtest', 'ledgertest', 'sheettest', 'entrytest', 'banktest', 'refusetest'];

// Files in here that are not suites: shared helpers, loaded by the ones
// that are. Everything else must be on the list above.
const NOT_SUITES = { 'all': 1, 'stub-guard': 1, 'payload': 1 };

// A suite nobody runs is worse than no suite: it reads like coverage and
// catches nothing. scantest sat unlisted for a whole session, passing on
// demand and never once in a full run.
const onDisk = fs.readdirSync(__dirname)
  .filter((f) => /\.js$/.test(f))
  .map((f) => f.replace(/\.js$/, ''))
  .filter((n) => !NOT_SUITES[n]);

const unlisted = onDisk.filter((n) => SUITES.indexOf(n) === -1);
if (unlisted.length) {
  console.log('These suites exist but are never run: ' + unlisted.join(', '));
  console.log('Add them to SUITES in test/all.js, or to NOT_SUITES if they are helpers.');
  process.exit(1);
}

const missing = SUITES.filter((n) => onDisk.indexOf(n) === -1);
if (missing.length) {
  console.log('These suites are listed but gone: ' + missing.join(', '));
  process.exit(1);
}

let failed = [];

SUITES.forEach((s) => {
  process.stdout.write('── ' + s + ' ');
  try {
    const out = execFileSync('node', [path.join(__dirname, s + '.js')], { encoding: 'utf8' });
    console.log(out.trim().split('\n').pop());
  } catch (e) {
    failed.push(s);
    console.log('FAILED');
    console.log((e.stdout || '').split('\n').filter((l) => l.indexOf('FAIL') > -1).join('\n'));
  }
});

if (failed.length) {
  console.log('\nFailing suites: ' + failed.join(', '));
  process.exit(1);
}
console.log('\nAll suites green.');

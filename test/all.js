// Runs every suite. One command before any deploy.
const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = ['es5', 'overtest', 'paint', 'matchtest', 'closetest', 'brieftest', 'ingesttest', 'extracttest', 'correcttest', 'contracttest'];
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

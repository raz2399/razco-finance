// Every line of browser JS in index.html must parse as ES5.
// Old iOS Safari in the office is the target; anything newer silently dies there.
const fs = require('fs');
const acorn = require('acorn');

const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const scripts = [];
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m, idx = 0;
while ((m = re.exec(html))) {
  if (/\bsrc=/.test(m[0])) continue;
  const before = html.slice(0, m.index);
  scripts.push({ n: ++idx, line: before.split('\n').length, code: m[1] });
}

let fail = 0;
scripts.forEach((s) => {
  try {
    acorn.parse(s.code, { ecmaVersion: 5, sourceType: 'script' });
    console.log('  ok   script #' + s.n + ' (line ' + s.line + ') parses as ES5');
  } catch (e) {
    fail++;
    const rel = s.code.slice(0, e.pos).split('\n').length;
    console.log('  FAIL script #' + s.n + ' — ' + e.message);
    console.log('       index.html line ~' + (s.line + rel - 1));
    console.log('       ' + s.code.split('\n')[rel - 1].trim().slice(0, 110));
  }
});

// Runtime APIs that do not exist on the target browser.
const banned = [
  [/\bfetch\s*\(/g, 'fetch() — use XMLHttpRequest'],
  [/\.forEach\s*\(/g, '.forEach on a NodeList — check it is a real Array'],
  [/\bPromise\b/g, 'Promise'],
  [/\bArray\.from\b/g, 'Array.from'],
  [/\bObject\.assign\b/g, 'Object.assign'],
];
console.log('\nRuntime API scan');
scripts.forEach((s) => {
  banned.forEach((b) => {
    const hits = s.code.match(b[0]);
    if (hits) console.log('  note script #' + s.n + ': ' + hits.length + ' x ' + b[1]);
  });
});

console.log('\n' + (scripts.length - fail) + '/' + scripts.length + ' scripts ES5-clean');
process.exit(fail ? 1 : 0);

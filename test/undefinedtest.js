// Nothing is called that was never brought in.
//
// ---------------------------------------------------------------------
// Why this suite exists
//
// Twice now the same bug has shipped. A helper gets used -- `money(...)`,
// `attach(...)` -- and the `require` line that would define it is never
// written. Nothing complains: Node resolves names at the moment the line
// runs, not when the file loads. So the function deploys, works for every
// normal request, and throws "money is not defined" on the one branch
// that only runs when something has already gone wrong. The error he sees
// is not the real problem, it is the error handler failing to report the
// real problem.
//
// Tests cannot catch this by exercising the code, because the broken line
// is in the path tests rarely reach. So this reads the source instead:
// every name used in every function file, checked against what that file
// declares, imports, or can expect from Node itself. Anything left over
// is a name that does not exist.

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');

// Names a Node function may use without declaring them.
const GLOBALS = {};
[
  // the module system
  'require', 'module', 'exports', '__dirname', '__filename',
  // the runtime
  'process', 'console', 'Buffer', 'global', 'globalThis', 'queueMicrotask',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'structuredClone', 'performance',
  // the web bits Node has
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'crypto',
  'TextEncoder', 'TextDecoder', 'btoa', 'atob', 'ReadableStream',
  // the language
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Promise', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Function', 'Reflect', 'Proxy', 'Intl', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'ArrayBuffer',
  'SharedArrayBuffer', 'DataView', 'Atomics',
  'undefined', 'NaN', 'Infinity', 'isNaN', 'isFinite', 'parseInt',
  'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'escape', 'unescape', 'eval', 'arguments',
].forEach((n) => { GLOBALS[n] = 1; });

// ---------------------------------------------------------------------
// Walking the tree
//
// Written by hand rather than pulled in, because the only dependency this
// repo has for parsing is acorn itself and a test that needs installing
// is a test that stops being run.

function children(node) {
  const out = [];
  Object.keys(node).forEach((key) => {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') return;
    const v = node[key];
    if (Array.isArray(v)) {
      v.forEach((c) => { if (c && typeof c.type === 'string') out.push(c); });
    } else if (v && typeof v.type === 'string') {
      out.push(v);
    }
  });
  return out;
}

const FUNCTIONS = {
  FunctionDeclaration: 1, FunctionExpression: 1, ArrowFunctionExpression: 1,
};

// Every name a pattern binds: plain, {a, b: c}, [a, ...rest], a = 1.
function namesIn(pattern, into) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': into.push(pattern.name); break;
    case 'ObjectPattern':
      pattern.properties.forEach((p) => {
        if (p.type === 'RestElement') namesIn(p.argument, into);
        else namesIn(p.value, into);
      });
      break;
    case 'ArrayPattern':
      pattern.elements.forEach((e) => namesIn(e, into));
      break;
    case 'AssignmentPattern': namesIn(pattern.left, into); break;
    case 'RestElement': namesIn(pattern.argument, into); break;
    default: break;
  }
}

// Everything declared inside one function body, not counting nested
// functions' own insides. Hoisting is treated generously -- let and const
// are gathered into the function scope rather than the block -- because
// this suite is hunting for names that exist NOWHERE, and being generous
// here only means it never cries wolf.
function declaredIn(node) {
  const names = [];

  if (FUNCTIONS[node.type]) {
    (node.params || []).forEach((p) => namesIn(p, names));
    if (node.id) names.push(node.id.name);
  }

  const stack = node.type === 'Program' ? children(node)
    : (node.body ? [node.body] : []);

  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'VariableDeclaration') {
      n.declarations.forEach((d) => namesIn(d.id, names));
    } else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') {
      if (n.id) names.push(n.id.name);
      continue;   // its insides belong to its own scope
    } else if (FUNCTIONS[n.type]) {
      continue;
    } else if (n.type === 'CatchClause') {
      namesIn(n.param, names);
    } else if (n.type === 'ImportDeclaration') {
      n.specifiers.forEach((s) => { if (s.local) names.push(s.local.name); });
    }
    children(n).forEach((c) => stack.push(c));
  }
  return names;
}

// A reference is an identifier being READ. Property names, keys and
// labels are not references, which is the whole difficulty.
function referencesIn(ast) {
  const refs = [];

  function walk(node, parent, key) {
    if (node.type === 'Identifier') {
      const skip =
        // obj.name -- the name is a property, not a variable
        (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
        // { name: ... } -- the key
        (parent && parent.type === 'Property' && key === 'key' && !parent.computed) ||
        // function name(...) / class Name
        (parent && (FUNCTIONS[parent.type] || parent.type === 'ClassDeclaration' ||
                    parent.type === 'ClassExpression') && key === 'id') ||
        // var name = ... / {a} = ... / [a] = ... / a = 1 in params
        (parent && parent.type === 'VariableDeclarator' && key === 'id') ||
        (parent && parent.type === 'AssignmentPattern' && key === 'left') ||
        (parent && parent.type === 'RestElement') ||
        (parent && parent.type === 'ObjectPattern') ||
        (parent && parent.type === 'ArrayPattern') ||
        (parent && parent.type === 'CatchClause' && key === 'param') ||
        // break outer; continue outer; outer:
        (parent && (parent.type === 'BreakStatement' ||
                    parent.type === 'ContinueStatement' ||
                    parent.type === 'LabeledStatement')) ||
        (parent && parent.type === 'MethodDefinition' && key === 'key') ||
        (parent && parent.type === 'PropertyDefinition' && key === 'key') ||
        // import { a as b } / export { a as b }
        (parent && /^(Import|Export)(Specifier|DefaultSpecifier|NamespaceSpecifier)$/
          .test(parent.type));
      if (!skip) refs.push({ name: node.name, node: node });
      return;
    }

    // Params are bindings, not references -- but their defaults are.
    if (FUNCTIONS[node.type]) {
      (node.params || []).forEach((p) => {
        if (p.type === 'AssignmentPattern') walk(p.right, p, 'right');
        else if (p.type === 'ObjectPattern') {
          p.properties.forEach((pr) => {
            if (pr.type === 'Property' && pr.value &&
                pr.value.type === 'AssignmentPattern') walk(pr.value.right, pr.value, 'right');
            if (pr.type === 'Property' && pr.computed) walk(pr.key, pr, 'key');
          });
        }
      });
      if (node.body) walk(node.body, node, 'body');
      return;
    }

    Object.keys(node).forEach((k) => {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') return;
      if (FUNCTIONS[node.type] && k === 'params') return;
      const v = node[k];
      if (Array.isArray(v)) {
        v.forEach((c) => { if (c && typeof c.type === 'string') walk(c, node, k); });
      } else if (v && typeof v.type === 'string') {
        walk(v, node, k);
      }
    });
  }

  walk(ast, null, null);
  return refs;
}

// Which function body an identifier sits in, innermost first, so the
// scopes it can draw names from are known.
function scopesOver(ast) {
  const scopes = [];
  function visit(node) {
    if (node.type === 'Program' || FUNCTIONS[node.type]) {
      scopes.push({ start: node.start, end: node.end, names: declaredIn(node) });
    }
    children(node).forEach(visit);
  }
  visit(ast);
  return scopes;
}

function parse(code) {
  // Most of these are CommonJS. probe.js is an ES module, so a file that
  // will not parse one way is tried the other before being called broken.
  try {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  } catch (e) {
    return acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
  }
}

function missingIn(code) {
  const ast = parse(code);
  const scopes = scopesOver(ast);
  const out = [];

  referencesIn(ast).forEach((ref) => {
    if (GLOBALS[ref.name]) return;
    const visible = scopes.some((s) =>
      ref.node.start >= s.start && ref.node.end <= s.end &&
      s.names.indexOf(ref.name) > -1);
    if (!visible) out.push(ref);
  });
  return { ast: ast, missing: out, code: code };
}

function lineOf(code, pos) {
  return code.slice(0, pos).split('\n').length;
}

// ---------------------------------------------------------------------

function filesUnder(dir) {
  const out = [];
  fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      out.push.apply(out, filesUnder(full));
    } else if (/\.js$/.test(name)) {
      out.push(full);
    }
  });
  return out;
}

let pass = 0;
let fail = 0;

console.log('\nevery name a function uses exists');

const files = filesUnder(path.join(ROOT, 'functions')).sort();

files.forEach((file) => {
  const rel = path.relative(ROOT, file);
  let res;
  try {
    res = missingIn(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + rel + ' does not parse: ' + e.message);
    return;
  }
  if (!res.missing.length) {
    pass += 1;
    console.log('  ok   ' + rel);
    return;
  }
  fail += 1;
  console.log('  FAIL ' + rel);
  const seen = {};
  res.missing.forEach((m) => {
    const key = m.name + ':' + lineOf(res.code, m.node.start);
    if (seen[key]) return;
    seen[key] = 1;
    console.log('       line ' + lineOf(res.code, m.node.start) +
                ': `' + m.name + '` is used but never defined or required');
  });
});

// ---------------------------------------------------------------------
// And the check that this suite is not simply saying yes to everything.
//
// Both bugs it exists to catch, written out again here, so a future
// change that quietly breaks the detector is caught by the detector's
// own test rather than by him on a Friday afternoon.

console.log('\nthe check itself still bites');

function bites(name, code, shouldFind) {
  const res = missingIn(code);
  const found = res.missing.map((m) => m.name);
  const hit = found.indexOf(shouldFind) > -1;
  if (hit) { pass += 1; console.log('  ok   ' + name); }
  else {
    fail += 1;
    console.log('  FAIL ' + name + ' -- `' + shouldFind +
                '` went unnoticed (found: ' + (found.join(', ') || 'nothing') + ')');
  }
}

function clean(name, code) {
  const res = missingIn(code);
  if (!res.missing.length) { pass += 1; console.log('  ok   ' + name); }
  else {
    fail += 1;
    console.log('  FAIL ' + name + ' -- cried wolf over: ' +
                res.missing.map((m) => m.name).join(', '));
  }
}

bites('a helper used but never required',
  'const { keep } = require("./lib/keepscan");\n' +
  'async function go(x) { return attach(x, "invoice", 1); }\n',
  'attach');

bites('a formatter used only in the error path',
  'exports.handler = async () => {\n' +
  '  try { return 1; } catch (e) { return money(e.amount); }\n' +
  '};\n',
  'money');

clean('a helper that IS required',
  'const { attach } = require("./lib/keepscan");\n' +
  'async function go(x) { return attach(x, "invoice", 1); }\n');

clean('names that only look undefined',
  'const o = { attach: 1, money: 2 };\n' +
  'function f({ a = 1, b: { c } = {} }, ...rest) {\n' +
  '  const [x, ...y] = rest;\n' +
  '  outer: for (const k in o) { if (k) break outer; }\n' +
  '  try { o.attach(); } catch (err) { return err.message + a + c + x + y; }\n' +
  '  return o["money"];\n' +
  '}\n' +
  'module.exports = { f };\n');

clean('a function hoisted below its own use',
  'exports.handler = () => helper(1);\n' +
  'function helper(n) { return n; }\n');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

// Every upsert in the codebase, against the indexes that actually exist.
//
// ---------------------------------------------------------------------
// The bug this exists to stop
//
// The bank sync upserted with onConflict: 'plaid_transaction_id'. There
// IS a unique index on that column. The upsert still failed, with:
//
//   "there is no unique or exclusion constraint matching the
//    ON CONFLICT specification"
//
// which reads like the index is missing, and it is sitting right there.
// The index is PARTIAL -- "WHERE plaid_transaction_id IS NOT NULL" --
// and Postgres will not use a partial index for ON CONFLICT unless the
// statement repeats the predicate, which PostgREST has no way to send.
//
// There are three ways to get this wrong and they all produce that same
// misleading sentence:
//
//   partial index      a WHERE on the index
//   expression index   unique on (store_id, upper(pattern)), not on
//                      (store_id, pattern)
//   wrong columns      naming columns the index does not cover, or that
//                      the table does not even have
//
// All three were live in this repo at once. None of them could be caught
// by a mock, because a mock accepts any conflict target you hand it --
// the database is the only thing that disagrees, and it only disagrees
// in production.
//
// So the real index list is pinned here, read out of the live schema,
// the same way entrytest pins the real check constraints. If someone
// adds an upsert whose conflict target no index can satisfy, this fails
// at the desk instead of at the bank.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNCS = path.join(ROOT, 'functions');

// ---- the live schema, copied from information_schema ------------------
// Only TOTAL unique indexes count. A partial or expression index is
// listed too, so the failure message can say why it does not qualify.
const UNIQUE_INDEXES = {
  plaid_items: [{ cols: 'item_id' }],
  bank_accounts: [
    { cols: 'account_id' },
    { cols: 'store_id,account_number' },
  ],
  store_sync: [{ cols: 'store_id' }],
  daily_sales: [{ cols: 'store_id,business_date' }],
  tender_totals: [{ cols: 'store_id,business_date,tender_id' }],
  dept_sales: [
    { cols: 'id' },
    { cols: 'business_date,department_id' },
  ],
  bank_transactions: [
    { cols: 'bank_txn_id' },
    { cols: 'import_hash' },
    { cols: 'plaid_transaction_id', partial: true },
  ],
  bank_rules: [
    { cols: 'rule_id' },
    { cols: 'store_id,upper(pattern)', expression: true },
  ],
  invoices: [{ cols: 'invoice_id' }],
  payments: [{ cols: 'payment_id' }],
  vendors: [{ cols: 'vendor_id' }],
  expense_categories: [{ cols: 'category_id' }],
  exceptions: [{ cols: 'exception_id' }],
};

// sync.js drives the Encore POS feed, which Raz has asked repeatedly be
// left alone. Its dept_sales upsert is broken -- it names dept_id and
// store_id against an index on (business_date, department_id), and the
// table has no dept_id column at all -- but fixing it is his call, not
// this suite's. Listed, not silently skipped, so it cannot be forgotten.
const KNOWN_BROKEN_NOT_OURS = {
  'sync.js': ['store_id,business_date,dept_id'],
};

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// Finds `.from('table')` ... `onConflict: 'a,b'` pairs. The table name is
// whichever .from() most recently preceded the onConflict.
function upsertsIn(src) {
  const out = [];
  const re = /onConflict:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(0, m.index);
    const from = before.lastIndexOf(".from('");
    const table = from === -1 ? null
      : before.slice(from + 7, before.indexOf("'", from + 7));
    out.push({ table: table, target: m[1] });
  }
  return out;
}

function walk(dir) {
  const files = [];
  fs.readdirSync(dir).forEach((f) => {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) files.push.apply(files, walk(full));
    else if (f.endsWith('.js')) files.push(full);
  });
  return files;
}

console.log('\nEvery conflict target matches a usable index');

let found = 0;
walk(FUNCS).forEach((file) => {
  const rel = path.relative(FUNCS, file);
  const src = fs.readFileSync(file, 'utf8');
  upsertsIn(src).forEach((u) => {
    found += 1;
    const known = KNOWN_BROKEN_NOT_OURS[rel] || [];
    if (known.indexOf(u.target) > -1) return;

    check(rel + ': ' + u.table + ' (' + u.target + ')', () => {
      assert.ok(u.table, 'could not tell which table this upserts into');
      const idx = UNIQUE_INDEXES[u.table];
      assert.ok(idx, u.table + ' is not in the pinned schema -- add it');

      const match = idx.filter((i) => i.cols === u.target)[0];
      if (!match) {
        const near = idx.filter((i) => i.cols.indexOf(u.target.split(',')[0]) > -1)[0];
        throw new Error('no unique index on (' + u.target + '). '
          + 'This table has: ' + idx.map((i) => i.cols
            + (i.partial ? ' [PARTIAL]' : '') + (i.expression ? ' [EXPRESSION]' : ''))
            .join('; ')
          + (near ? '' : ''));
      }
      assert.ok(!match.partial,
        '(' + u.target + ') is a PARTIAL index. Postgres will not use one for '
        + 'ON CONFLICT -- pick a total unique index instead.');
      assert.ok(!match.expression,
        '(' + u.target + ') is an EXPRESSION index. ON CONFLICT cannot name it '
        + 'through PostgREST -- look the row up and update it instead.');
    });
  });
});

check('it actually found the upserts', () => {
  assert.ok(found >= 7, 'only found ' + found + ' -- the scan is broken');
});

console.log('\nThe one that is not ours');
check('sync.js dept_sales is recorded as broken, not quietly passing', () => {
  const src = fs.readFileSync(path.join(FUNCS, 'sync.js'), 'utf8');
  assert.ok(src.indexOf("onConflict: 'store_id,business_date,dept_id'") > -1,
    'sync.js changed -- re-check whether dept_sales is still broken and '
    + 'update KNOWN_BROKEN_NOT_OURS');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

// 1099 reporting, and the four ways it could be wrong.
//
// Each test here is a way Raz could end up either filing a form that
// causes somebody a problem, or missing one that costs him a penalty:
//
//   - counting a card payment       reports the same income twice
//                                   against that person, because the
//                                   card network already reported it
//   - counting goods                sends forms to grocery distributors
//   - counting per invoice          misses anyone who crossed $600 across
//                                   several smaller payments
//   - counting a voided check       reports money that never moved

const assert = require('assert');
const path = require('path');
const Module = require('module');
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

const DB = {
  vendors: [
    { vendor_id: 'v-sysco', store_id: 'store1', name: 'Sysco',
      default_category_id: 1, is_1099: false, w9_on_file: false },
    { vendor_id: 'v-plumb', store_id: 'store1', name: 'RYL PLUMBING',
      default_category_id: 5, is_1099: true, w9_on_file: true },
    { vendor_id: 'v-juan', store_id: 'store1', name: 'JUAN MARTINEZ',
      default_category_id: 5, is_1099: true, w9_on_file: false },
    { vendor_id: 'v-small', store_id: 'store1', name: 'ONE JOB GUY',
      default_category_id: 5, is_1099: true, w9_on_file: true },
    { vendor_id: 'v-new', store_id: 'store1', name: 'ALVINOS MAINTENANCE',
      default_category_id: 5, is_1099: false, w9_on_file: false },
    { vendor_id: 'v-card', store_id: 'store1', name: 'CARD ONLY CONTRACTOR',
      default_category_id: 5, is_1099: false, w9_on_file: false },
  ],
  expense_categories: [
    { category_id: 1, store_id: 'store1', name: 'Merchandise', ledger_type: 'cogs' },
    { category_id: 5, store_id: 'store1', name: 'Repairs & Maintenance', ledger_type: 'opex' },
  ],
  payments: [
    // goods, huge, must never appear
    { payment_id: 'p1', store_id: 'store1', vendor_id: 'v-sysco', amount: 708705.19,
      payment_date: '2026-03-01', method: 'check', status: 'cleared' },
    // a plain reportable contractor
    { payment_id: 'p2', store_id: 'store1', vendor_id: 'v-plumb', amount: 4200,
      payment_date: '2026-04-02', method: 'check', status: 'cleared' },
    // crosses $600 only when the year is added up: 3 x 250
    { payment_id: 'p3', store_id: 'store1', vendor_id: 'v-juan', amount: 250,
      payment_date: '2026-02-02', method: 'check', status: 'cleared' },
    { payment_id: 'p4', store_id: 'store1', vendor_id: 'v-juan', amount: 250,
      payment_date: '2026-05-02', method: 'ach', status: 'cleared' },
    { payment_id: 'p5', store_id: 'store1', vendor_id: 'v-juan', amount: 250,
      payment_date: '2026-09-02', method: 'cash', status: 'cleared' },
    // under the line
    { payment_id: 'p6', store_id: 'store1', vendor_id: 'v-small', amount: 400,
      payment_date: '2026-06-02', method: 'check', status: 'cleared' },
    // not yet marked, but clearly worth a look
    { payment_id: 'p7', store_id: 'store1', vendor_id: 'v-new', amount: 9500,
      payment_date: '2026-07-02', method: 'check', status: 'cleared' },
    // paid by card: the network reports this one, not Raz
    { payment_id: 'p8', store_id: 'store1', vendor_id: 'v-card', amount: 5000,
      payment_date: '2026-08-02', method: 'card', status: 'cleared' },
    // voided: the money never moved
    { payment_id: 'p9', store_id: 'store1', vendor_id: 'v-plumb', amount: 99999,
      payment_date: '2026-08-03', method: 'check', status: 'void' },
    // last year, out of range
    { payment_id: 'p10', store_id: 'store1', vendor_id: 'v-plumb', amount: 50000,
      payment_date: '2025-04-02', method: 'check', status: 'cleared' },
  ],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    gte(col, val) { rows = rows.filter((r) => String(r[col]) >= val); return api; },
    lte(col, val) { rows = rows.filter((r) => String(r[col]) <= val); return api; },
    range() { return api; },
    update() { return api; },
    then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
  };
  return api;
}

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => ({ from: query }) };
  }
  return orig.apply(this, arguments);
};
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';

const { handler } = require(path.join(ROOT, 'functions', 'tax-1099.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  return fn().then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch((e) => { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); });
}

const get = () => handler({
  httpMethod: 'GET',
  queryStringParameters: { store_id: 'store1', year: '2026' },
  headers: { authorization: 'Bearer test' },
}).then((r) => JSON.parse(r.body));

console.log('\n1099');

Promise.resolve()
  .then(() => check('a $708,705 grocery supplier gets NO form', () => get().then((b) => {
    const names = b.reportable.concat(b.candidates).map((r) => r.name);
    assert.ok(names.indexOf('Sysco') === -1,
      'Sysco appeared; buying goods is not a reportable service');
  })))

  .then(() => check('a card-paid contractor is excluded', () => get().then((b) => {
    const names = b.reportable.concat(b.candidates).map((r) => r.name);
    assert.ok(names.indexOf('CARD ONLY CONTRACTOR') === -1,
      'the card network already reports this one');
    assert.strictEqual(b.summary.payments_excluded_as_card, 1);
  })))

  .then(() => check('a voided check is not money paid', () => get().then((b) => {
    const plumb = b.reportable.filter((r) => r.name === 'RYL PLUMBING')[0];
    assert.ok(plumb, 'RYL PLUMBING should be reportable');
    assert.strictEqual(plumb.paid, 4200,
      'the $99,999 void was counted');
    assert.strictEqual(b.summary.payments_excluded_as_void, 1);
  })))

  .then(() => check('last year stays in last year', () => get().then((b) => {
    const plumb = b.reportable.filter((r) => r.name === 'RYL PLUMBING')[0];
    assert.strictEqual(plumb.paid, 4200, '2025 payment leaked in');
  })))

  .then(() => check('$600 is a YEAR total, not a per-invoice one', () => get().then((b) => {
    const juan = b.reportable.filter((r) => r.name === 'JUAN MARTINEZ')[0];
    assert.ok(juan, 'JUAN MARTINEZ missing');
    assert.strictEqual(juan.paid, 750, 'three 250s should add to 750');
    assert.strictEqual(juan.over_threshold, true,
      'no single payment hit 600, but the year did');
  })))

  .then(() => check('under $600 means no form owed', () => get().then((b) => {
    const small = b.reportable.filter((r) => r.name === 'ONE JOB GUY')[0];
    assert.strictEqual(small.over_threshold, false);
    assert.strictEqual(b.summary.marked_but_under_threshold, 1);
    assert.strictEqual(b.summary.forms_to_file, 2,
      'only RYL PLUMBING and JUAN MARTINEZ');
  })))

  .then(() => check('a missing W-9 is counted on its own', () => get().then((b) => {
    assert.strictEqual(b.summary.missing_w9, 1);
    assert.strictEqual(b.missing_w9[0].name, 'JUAN MARTINEZ');
  })))

  .then(() => check('an unmarked contractor over $600 is raised, not assumed', () => get().then((b) => {
    const cand = b.candidates.map((r) => r.name);
    assert.ok(cand.indexOf('ALVINOS MAINTENANCE') > -1, 'should be a candidate');
    const marked = b.reportable.map((r) => r.name);
    assert.ok(marked.indexOf('ALVINOS MAINTENANCE') === -1,
      'must NOT be filed automatically -- that is a judgement call');
  })))

  .then(() => check('the deadline is stated', () => get().then((b) => {
    assert.strictEqual(b.forms_due, '2027-01-31');
    assert.ok(b.notes.join(' ').indexOf('not tax advice') > -1);
  })))

  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });

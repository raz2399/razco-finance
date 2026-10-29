// Tests adding, editing, clearing and importing vendor lines.
//
// The mock below enforces the database's real check constraints and its
// generated column, because the two bugs this code could plausibly ship
// are exactly the ones Postgres would catch and nothing else would:
//
//   - writing balance_due, which is generated from total minus paid
//   - writing a payment method or a status that is not on the allowed list
//
// A mock that accepts anything would let both through and the tests would
// pass while the live endpoint returned 500.
//
// The behaviour that matters most, and is tested by name: marking an
// invoice "already paid" must NOT write a payment row. If it did, a bill
// settled in QuickBooks last month would show a check leaving the bank
// here, and the expense would be counted twice.

const path = require('path');
const Module = require('module');
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

// ---- the real constraints, copied from the live schema ---------------
const PAYMENT_METHODS = ['check', 'ach', 'auto_debit', 'cash', 'card', 'wire'];
const INVOICE_STATUSES = ['captured', 'extracted', 'needs_review', 'approved',
  'scheduled', 'partially_paid', 'paid', 'void', 'disputed'];
const PAYMENT_STATUSES = ['draft', 'pending_approval', 'approved', 'issued',
  'outstanding', 'cleared', 'void', 'stopped'];

let DB;
let seq;

function reset() {
  seq = 0;
  DB = {
    vendors: [
      { vendor_id: '11111111-1111-4111-8111-111111111111', store_id: 'store1',
        name: 'Sysco', payment_type: 'charge_account', terms_code: 'net15',
        terms_days: 15, active: true },
      { vendor_id: '22222222-2222-4222-8222-222222222222', store_id: 'store1',
        name: 'M & J Seafood Co., Inc.', payment_type: 'check', terms_code: 'net7',
        terms_days: 7, active: true },
      { vendor_id: '33333333-3333-4333-8333-333333333333', store_id: 'store2',
        name: 'Somebody Else', payment_type: 'check', terms_code: 'net30',
        terms_days: 30, active: true },
    ],
    vendor_aliases: [
      { vendor_id: '22222222-2222-4222-8222-222222222222', alias_text: 'M&J SEA FOOD' },
    ],
    invoices: [],
    payments: [],
    payment_allocations: [],
    exceptions: [],
  };
}

const SYSCO = '11111111-1111-4111-8111-111111111111';
const MJ = '22222222-2222-4222-8222-222222222222';

// Real UUIDs. The endpoint checks the shape of every id it is handed --
// an id is the only thing standing between an edit and somebody else's
// books -- so a mock that hands out "i0000000-..." tests nothing except
// that the check works.
const TABLE_TAG = {
  invoices: 'a', payments: 'b', vendors: 'c',
  payment_allocations: 'd', exceptions: 'e',
};
function newId(table) {
  seq += 1;
  return (TABLE_TAG[table] || 'f') + '0000000-0000-4000-8000-' +
         String(seq).padStart(12, '0');
}

// `written` is the column list the caller actually sent. The generated
// column check has to look at THAT and not at the merged row: every stored
// invoice carries a balance_due, so checking the merged row would reject
// every update ever made, including the correct ones.
function enforce(table, row, written) {
  const sent = written || row;
  if (table === 'invoices') {
    if ('balance_due' in sent) {
      throw new Error('cannot insert a non-DEFAULT value into column "balance_due"');
    }
    if (row.status != null && INVOICE_STATUSES.indexOf(row.status) === -1) {
      throw new Error('new row violates check constraint "invoices_status_check"');
    }
  }
  if (table === 'payments') {
    if (row.method != null && PAYMENT_METHODS.indexOf(row.method) === -1) {
      throw new Error('new row violates check constraint "payments_method_check"');
    }
    if (row.status != null && PAYMENT_STATUSES.indexOf(row.status) === -1) {
      throw new Error('new row violates check constraint "payments_status_check"');
    }
  }
  if (table === 'exceptions') {
    if (['info', 'warn', 'critical'].indexOf(row.severity) === -1) {
      throw new Error('new row violates check constraint "exceptions_severity_check"');
    }
  }
}

function generated(table, row) {
  if (table === 'invoices') {
    row.balance_due = Math.round(
      (Number(row.total_amount || 0) - Number(row.amount_paid || 0)) * 100) / 100;
  }
  return row;
}

function query(table) {
  let filters = [];
  let pending = null;   // rows produced by insert/update, for .select().single()
  let work = null;      // a deferred update, run once the filters are in
  let error = null;

  // Supabase hands back copies, not the rows themselves. The mock does the
  // same, because handing out live objects lets a caller read a figure
  // AFTER its own update has already changed it and still see the old
  // value -- which is a bug that only appears against the real database.
  const copy = (rows) => rows.map((r) => Object.assign({}, r));

  // Runs a deferred write, if there is one, and remembers what it touched.
  function settleWork() {
    if (!work) return;
    const run = work;
    work = null;
    try { pending = run(); } catch (e) { error = { message: e.message }; }
  }

  const matching = () => (DB[table] || []).filter((r) =>
    filters.every((f) => f(r)));

  const api = {
    select() { return api; },
    eq(col, val) { filters.push((r) => r[col] === val); return api; },
    neq(col, val) { filters.push((r) => r[col] !== val); return api; },
    in(col, vals) { filters.push((r) => vals.indexOf(r[col]) > -1); return api; },
    ilike() { return api; },
    order() { return api; },
    limit(n) { const f = filters; filters = f; api._limit = n; return api; },

    insert(payload) {
      const made = [];
      try {
        (Array.isArray(payload) ? payload : [payload]).forEach((r) => {
          enforce(table, r);
          const row = generated(table, Object.assign({}, r));
          const idCol = table === 'invoices' ? 'invoice_id'
                      : table === 'payments' ? 'payment_id'
                      : table === 'vendors' ? 'vendor_id'
                      : table === 'payment_allocations' ? 'allocation_id'
                      : table === 'exceptions' ? 'exception_id' : null;
          if (idCol && !row[idCol]) row[idCol] = newId(table);
          if (!row.created_at) row.created_at = new Date().toISOString();
          DB[table].push(row);
          made.push(row);
        });
        pending = made;
      } catch (e) {
        error = { message: e.message };
      }
      return api;
    },

    // Deferred for the same reason as update: .delete() is written before
    // the .eq()/.in() that says which rows.
    delete() {
      work = () => {
        const hit = matching();
        DB[table] = (DB[table] || []).filter((r) => hit.indexOf(r) === -1);
        return hit;
      };
      return api;
    },

    // Deferred on purpose. supabase-js is written .update(patch).eq(...),
    // so at the moment update() is called the filters that say WHICH rows
    // do not exist yet. Applying it here would quietly rewrite every row
    // in the table and the tests would still pass -- while the endpoint,
    // against the real database, updated only the row it meant to. A mock
    // that is wrong in the forgiving direction is worse than no mock.
    update(patch) {
      work = () => {
        const hit = matching();
        hit.forEach((r) => {
          enforce(table, Object.assign({}, r, patch), patch);
          Object.assign(r, patch);
          generated(table, r);
        });
        return hit;
      };
      return api;
    },

    maybeSingle() {
      settleWork();
      if (error) return Promise.resolve({ data: null, error: error });
      const rows = copy(pending || matching());
      return Promise.resolve({ data: rows[0] || null, error: null });
    },
    single() {
      settleWork();
      if (error) return Promise.resolve({ data: null, error: error });
      const rows = copy(pending || matching());
      return Promise.resolve({
        data: rows[0] || null,
        error: rows.length ? null : { message: 'no rows' },
      });
    },
    then(res) {
      settleWork();
      if (error) return Promise.resolve({ data: null, error: error }).then(res);
      let rows = copy(pending || matching());
      if (api._limit) rows = rows.slice(0, api._limit);
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB13';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB13 = {
  id: 'MOCK_SB13', filename: 'MOCK_SB13', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { handler } = require(path.join(ROOT, 'functions', 'vendor-entry.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else {
    fail++;
    console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) +
                '\n       expected ' + JSON.stringify(b));
  }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const POST = async (payload, store) => {
  const r = await handler({
    httpMethod: 'POST',
    headers: { Authorization: 'Bearer t' },
    queryStringParameters: { store_id: store || 'store1' },
    body: JSON.stringify(Object.assign({ store_id: store || 'store1' }, payload)),
  });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

const inv = (id) => DB.invoices.filter((i) => i.invoice_id === id)[0];

(async () => {
  // ---- adding an invoice by hand ------------------------------------
  reset();
  console.log('Adding an invoice by hand');
  let r = await POST({ action: 'add_invoice', vendor_id: SYSCO,
    invoice_number: '9001', invoice_date: '2026-10-20', total_amount: '1,245.80' });
  check('saved', r.status, 200);
  check('one invoice on the books', DB.invoices.length, 1);
  check('for the right money', DB.invoices[0].total_amount, 1245.80);
  check('the comma did not become a second field', DB.invoices[0].total_amount, 1245.80);
  check('and the balance was worked out, not written', DB.invoices[0].balance_due, 1245.80);
  check('due fifteen days later, from the terms', DB.invoices[0].due_date, '2026-11-04');
  check('nothing paid on it', DB.invoices[0].amount_paid, 0);
  checkTrue('and it left a trail',
    DB.exceptions.some((e) => e.code === 'manual_invoice'));

  console.log('\nThe same invoice number twice');
  r = await POST({ action: 'add_invoice', vendor_id: SYSCO,
    invoice_number: '9001', invoice_date: '2026-10-21', total_amount: '1245.80' });
  check('stopped', r.status, 409);
  checkTrue('and told which one it clashes with', !!r.body.duplicate_of);
  check('nothing was doubled', DB.invoices.length, 1);

  r = await POST({ action: 'add_invoice', vendor_id: SYSCO, invoice_number: '9001',
    invoice_date: '2026-10-21', total_amount: '1245.80', allow_duplicate: true });
  check('unless he says go ahead', r.status, 200);
  check('then there are two', DB.invoices.length, 2);

  console.log('\nAn invoice with no money on it');
  r = await POST({ action: 'add_invoice', vendor_id: SYSCO, invoice_date: '2026-10-20' });
  check('refused', r.status, 400);
  checkTrue('asking how much', /how much/i.test(r.body.error), r.body.error);

  console.log('\nA vendor that is not his');
  r = await POST({ action: 'add_invoice', vendor_id: '33333333-3333-4333-8333-333333333333',
    invoice_number: 'X', invoice_date: '2026-10-20', total_amount: '10' });
  check('refused', r.status, 404);

  // ---- already paid, but not through here ---------------------------
  reset();
  console.log('\nMarked already paid: the balance clears and no check appears');
  await POST({ action: 'add_invoice', vendor_id: SYSCO, invoice_number: 'QB-OPEN',
    invoice_date: '2026-10-28', total_amount: '20508.53' });
  const openId = DB.invoices[0].invoice_id;

  r = await POST({ action: 'settle', invoice_ids: [openId] });
  check('cleared', r.status, 200);
  check('one invoice', r.body.settled, 1);
  check('for its whole balance', r.body.cleared, 20508.53);
  check('nothing left owing on it', inv(openId).balance_due, 0);
  check('paid in full', inv(openId).amount_paid, 20508.53);
  check('and marked paid', inv(openId).status, 'paid');

  // THE assertion this file exists for.
  check('NO payment row was written', DB.payments.length, 0);
  check('and no allocation either', DB.payment_allocations.length, 0);
  checkTrue('the reply says so in words',
    /did not leave through this system/i.test(r.body.says), r.body.says);
  checkTrue('the note on the invoice says where it was paid',
    /outside this system/i.test(inv(openId).notes), inv(openId).notes);
  checkTrue('and the trail calls it what it is',
    DB.exceptions.some((e) => e.code === 'marked_already_paid'));

  console.log('\nAnd it can be put back');
  r = await POST({ action: 'unsettle', invoice_ids: [openId] });
  check('undone', r.status, 200);
  check('owing again', inv(openId).balance_due, 20508.53);
  check('and nothing paid', inv(openId).amount_paid, 0);
  checkTrue('with the marking taken off the note',
    !/Marked already paid/.test(inv(openId).notes || ''), inv(openId).notes);

  console.log('\nEvery open invoice on a vendor at once');
  reset();
  for (const n of ['1', '2', '3']) {
    await POST({ action: 'add_invoice', vendor_id: SYSCO, invoice_number: n,
      invoice_date: '2026-10-2' + n, total_amount: '100' });
  }
  await POST({ action: 'add_invoice', vendor_id: MJ, invoice_number: '9',
    invoice_date: '2026-10-20', total_amount: '500' });

  r = await POST({ action: 'settle', vendor_id: SYSCO, all_open: true });
  check('three cleared', r.body.settled, 3);
  check('three hundred off', r.body.cleared, 300);
  checkTrue('and the other vendor was left alone',
    DB.invoices.filter((i) => i.vendor_id === MJ)[0].balance_due === 500);
  check('still no payments invented', DB.payments.length, 0);

  console.log('\nAsking twice does not double anything');
  r = await POST({ action: 'settle', vendor_id: SYSCO, all_open: true });
  check('nothing left to clear', r.body.settled, 0);
  checkTrue('and it says so plainly',
    /nothing was left owing/i.test(r.body.says), r.body.says);

  // ---- paying it now, from here -------------------------------------
  reset();
  console.log('\nPaying it now: that DOES write a check');
  await POST({ action: 'add_invoice', vendor_id: MJ, invoice_number: '500',
    invoice_date: '2026-10-20', total_amount: '412.90' });
  await POST({ action: 'add_invoice', vendor_id: MJ, invoice_number: '501',
    invoice_date: '2026-10-22', total_amount: '87.10' });

  r = await POST({ action: 'pay_now', vendor_id: MJ, all_open: true,
    method: 'check', check_number: '9601', payment_date: '2026-10-28' });
  check('paid', r.status, 200);
  check('one check written', DB.payments.length, 1);
  check('for both invoices together', DB.payments[0].amount, 500);
  check('with the check number', DB.payments[0].check_number, 9601);
  check('outstanding until the bank takes it', DB.payments[0].status, 'outstanding');
  check('and it is recorded against both bills', DB.payment_allocations.length, 2);
  checkTrue('both of which are now paid',
    DB.invoices.every((i) => i.balance_due === 0));

  console.log('\nA payment method the database will not accept');
  r = await POST({ action: 'add_payment', vendor_id: MJ, amount: '50',
    method: 'cod_draft', payment_date: '2026-10-28' });
  check('caught here, not by Postgres', r.status, 400);
  checkTrue('and the real list is offered',
    r.body.methods.join(',') === PAYMENT_METHODS.join(','), JSON.stringify(r.body));

  console.log('\nA payment bigger than the bills it is against');
  reset();
  await POST({ action: 'add_invoice', vendor_id: SYSCO, invoice_number: '1',
    invoice_date: '2026-10-20', total_amount: '100' });
  r = await POST({ action: 'add_payment', vendor_id: SYSCO, amount: '250',
    method: 'check', check_number: '9700', payment_date: '2026-10-28' });
  check('recorded', r.status, 200);
  check('a hundred of it went on the bill', r.body.applied_total, 100);
  check('and it says what is left over', r.body.left_over, 150);
  checkTrue('no invoice shows as overpaid',
    DB.invoices.every((i) => Number(i.amount_paid) <= Number(i.total_amount)));

  // ---- fixing a line ------------------------------------------------
  reset();
  console.log('\nFixing a number that was keyed wrong');
  await POST({ action: 'add_invoice', vendor_id: SYSCO, invoice_number: '9001',
    invoice_date: '2026-10-20', total_amount: '1245.80' });
  const fixId = DB.invoices[0].invoice_id;

  r = await POST({ action: 'edit', kind: 'invoice', id: fixId,
    fields: { total_amount: '1254.80', invoice_number: '9001-A' } });
  check('changed', r.status, 200);
  check('the amount', inv(fixId).total_amount, 1254.80);
  check('the number', inv(fixId).invoice_number, '9001-A');
  check('and the balance followed it', inv(fixId).balance_due, 1254.80);
  checkTrue('with the before and after written down',
    r.body.changed.some((c) => /1245.8.*1254.8/.test(c)), JSON.stringify(r.body.changed));
  checkTrue('and a trail', DB.exceptions.some((e) => e.code === 'manual_edit'));

  console.log('\nThings an edit form is not allowed to move');
  r = await POST({ action: 'edit', kind: 'invoice', id: fixId,
    fields: { balance_due: 0, store_id: 'store2', vendor_id: MJ, invoice_number: '9002' } });
  check('the one real change went through', inv(fixId).invoice_number, '9002');
  check('the balance was not written', inv(fixId).balance_due, 1254.80);
  check('the store did not move', inv(fixId).store_id, 'store1');
  check('nor the vendor', inv(fixId).vendor_id, SYSCO);
  check('and all three were named as refused', r.body.refused.length, 3);

  console.log('\nPaid more than the invoice is for');
  r = await POST({ action: 'edit', kind: 'invoice', id: fixId,
    fields: { amount_paid: '9999' } });
  check('refused', r.status, 400);
  check('and nothing changed', inv(fixId).amount_paid, 0);

  console.log('\nA status that is not a status');
  r = await POST({ action: 'edit', kind: 'invoice', id: fixId,
    fields: { status: 'sort of paid' } });
  check('refused before it reaches the database', r.status, 400);

  console.log('\nEditing a line in another store');
  r = await POST({ action: 'edit', kind: 'invoice', id: fixId, fields: { total_amount: '1' } }, 'store2');
  checkTrue('refused', r.status === 403 || r.status === 404, 'got ' + r.status);
  check('and the figure stands', inv(fixId).total_amount, 1254.80);

  console.log('\nVoiding a check puts the money back');
  // Found live, not imagined: a $2,242.87 check was voided and $964.37 of
  // it stayed allocated to the bill. The payment read VOID and the invoice
  // read PAID at the same time. Void a check on a real invoice and he
  // stops chasing money he still owes.
  reset();
  await POST({ action: 'add_invoice', vendor_id: MJ, invoice_number: 'V1',
    invoice_date: '2026-10-20', total_amount: '964.37' });
  const vInv = DB.invoices[0].invoice_id;
  await POST({ action: 'add_payment', vendor_id: MJ, amount: '2242.87',
    method: 'check', check_number: '9800', payment_date: '2026-10-28' });
  const vPay = DB.payments[0].payment_id;

  check('the bill was settled by the check', inv(vInv).balance_due, 0);
  check('and the allocation is there', DB.payment_allocations.length, 1);

  r = await POST({ action: 'void', kind: 'payment', id: vPay, note: 'Wrong vendor' });
  check('voided', r.status, 200);
  check('the check is void', DB.payments[0].status, 'void');
  check('the bill is owed again', inv(vInv).balance_due, 964.37);
  check('nothing is paid on it', inv(vInv).amount_paid, 0);
  check('and it is open again, not paid', inv(vInv).status, 'approved');
  check('the allocation is gone', DB.payment_allocations.length, 0);
  check('and the reply says what came back', r.body.put_back, 964.37);
  checkTrue('in words too', /owed again/i.test(r.body.says), r.body.says);

  console.log('\nVoiding the invoice instead leaves the check alone');
  // The money really did leave the bank. What changes is that it is no
  // longer against this bill.
  reset();
  await POST({ action: 'add_invoice', vendor_id: MJ, invoice_number: 'V2',
    invoice_date: '2026-10-20', total_amount: '500' });
  const vInv2 = DB.invoices[0].invoice_id;
  await POST({ action: 'add_payment', vendor_id: MJ, amount: '500',
    method: 'check', check_number: '9801', payment_date: '2026-10-28' });

  r = await POST({ action: 'void', kind: 'invoice', id: vInv2, note: 'Never delivered' });
  check('the invoice is void', inv(vInv2).status, 'void');
  check('the check still exists', DB.payments[0].status, 'outstanding');
  check('for its full amount', DB.payments[0].amount, 500);
  check('but no longer against that bill', DB.payment_allocations.length, 0);

  console.log('\nVoiding a line');
  r = await POST({ action: 'void', kind: 'invoice', id: fixId, note: 'Keyed twice' });
  check('voided', r.status, 200);
  check('marked void, not deleted', inv(fixId).status, 'void');
  check('still on the books', DB.invoices.length, 1);
  checkTrue('with the reason kept', /Keyed twice/.test(inv(fixId).notes));

  // ---- importing a sheet --------------------------------------------
  reset();
  console.log('\nImporting a sheet: the preview writes nothing');
  const sheet = [
    'Date,Transaction Type,Num,Vendor,Due Date,Amount,Open Balance',
    '10/05/2026,Bill,9001,Sysco,10/20/2026,"1,245.80",0.00',
    '10/12/2026,Bill,9015,Sysco,10/27/2026,"2,100.00","2,100.00"',
    '10/14/2026,Bill,77,"M&J SEA FOOD",10/21/2026,412.90,412.90',
    '10/19/2026,Bill Pmt -Check,9500,Sysco,,"1,245.80",0.00',
    '10/20/2026,Bill,900,Nobody We Know,10/30/2026,50.00,50.00',
    'Total,,,,,"3,758.70",',
  ].join('\n');

  r = await POST({ action: 'import', sheet: sheet, preview: true });
  check('previewed', r.status, 200);
  check('and it is a preview', r.body.preview, true);
  check('nothing was written', DB.invoices.length, 0);
  check('no payments either', DB.payments.length, 0);
  check('recognised the shape', r.body.summary.shape, 'aging report');

  check('four lines it can place', r.body.summary.to_add, 4);
  check('three bills', r.body.summary.invoices, 3);
  check('one payment', r.body.summary.payments, 1);
  check('one already paid, because the sheet said so',
    r.body.summary.will_be_marked_paid, 1);
  check('the total line was skipped', r.body.summary.skipped, 1);

  // The unknown vendor must be reported, not invented and not dropped.
  check('one row it cannot place', r.body.summary.problems, 1);
  checkTrue('because that vendor is not on file',
    /Nobody We Know/.test(r.body.problems[0].why), JSON.stringify(r.body.problems));

  checkTrue('found M & J by the spelling on the paper',
    r.body.plan.some((p) => p.vendor_name === 'M & J Seafood Co., Inc.'),
    JSON.stringify(r.body.plan.map((p) => p.vendor_name)));

  // The figure he checks against the sheet before pressing the button:
  // 2,100 + 412.90 owed, less the 1,245.80 payment. The already-paid
  // 1,245.80 bill adds nothing.
  check('and it says what this will add to what he owes',
    r.body.summary.adds_to_what_you_owe, 1267.10);

  console.log('\nThen for real');
  r = await POST({ action: 'import', sheet: sheet, preview: false });
  check('imported', r.status, 200);
  check('three invoices', r.body.added_invoices, 3);
  check('one payment', r.body.added_payments, 1);
  check('one of them straight in as paid', r.body.marked_paid, 1);
  check('nothing failed to save', r.body.failed.length, 0);

  const paidOne = DB.invoices.filter((i) => i.invoice_number === '9001')[0];
  check('the already-paid bill owes nothing', paidOne.balance_due, 0);
  checkTrue('and says where it was paid',
    /outside this system/.test(paidOne.notes), paidOne.notes);

  const stillOwed = DB.invoices.filter((i) => i.invoice_number === '9015')[0];
  check('the open one still owes the lot', stillOwed.balance_due, 2100);
  check('with its due date off the sheet', stillOwed.due_date, '2026-10-27');

  const imported = DB.payments[0];
  check('the imported check is cleared, not left outstanding', imported.status, 'cleared');
  checkTrue('so it never lands on the checks-still-out list',
    imported.cleared_date === '2026-10-19', imported.cleared_date);

  console.log('\nThe same sheet imported twice');
  r = await POST({ action: 'import', sheet: sheet, preview: false });
  check('nothing added the second time', r.body.added_invoices, 0);
  check('three of them recognised as already on the books',
    r.body.summary.duplicates, 3);
  check('and the books did not grow', DB.invoices.length, 3);

  console.log('\nA sheet for one chosen vendor, with no vendor column');
  reset();
  r = await POST({ action: 'import', vendor_id: MJ, preview: false, sheet: [
    'Date,Invoice #,Amount,Due Date',
    '10/01/2026,500,800.00,10/16/2026',
    '10/08/2026,501,"1,600.00",10/23/2026',
  ].join('\n') });
  check('both in', r.body.added_invoices, 2);
  checkTrue('both on the vendor he picked',
    DB.invoices.every((i) => i.vendor_id === MJ));

  console.log('\nA sheet that is not a ledger');
  r = await POST({ action: 'import', sheet: 'name,phone\nSysco,559-555-1212' });
  check('refused', r.status, 400);
  checkTrue('and says what is missing',
    /Date heading and an Amount heading/.test(r.body.error), r.body.error);

  console.log('\nNo action at all');
  r = await POST({ foo: 'bar' });
  check('refused', r.status, 400);
  checkTrue('and lists what it can do', r.body.actions.indexOf('settle') > -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

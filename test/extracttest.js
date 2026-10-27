// Tests invoice-extract. The point of these is that a number read off a
// photograph is never quietly trusted.

const path = require('path');
const Module = require('module');

const DB = {
  vendors: [
    { vendor_id: 'v1', store_id: 'store1', name: 'Pac Agri Foods',
      payment_type: 'check', terms_code: 'net15', terms_days: 15 },
  ],
  invoices: [
    { invoice_id: 'old', store_id: 'store1', vendor_id: 'v1', invoice_number: '971039',
      invoice_date: '2026-10-20', total_amount: 9473.14, status: 'approved' },
  ],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    neq(col, val) { rows = rows.filter((r) => r[col] !== val); return api; },
    ilike(col, pattern) {
      const needle = pattern.replace(/%/g, '').toLowerCase();
      rows = rows.filter((r) => String(r[col] || '').toLowerCase().includes(needle));
      return api;
    },
    limit(n) { rows = rows.slice(0, n); return api; },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  };
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB5';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB5 = {
  id: 'MOCK_SB5', filename: 'MOCK_SB5', loaded: true,
  exports: { createClient: () => ({ from: query }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';

// Stand in for the vision call. Each test sets what the model "saw".
let modelSays = null;
let modelFails = false;
let lastRequest = null;
global.fetch = async (url, options) => {
  lastRequest = { url, body: JSON.parse(options.body) };
  if (modelFails) {
    return { ok: false, status: 529, text: async () => 'overloaded' };
  }
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: modelSays }] }),
  };
};

const { handler } = require(path.join(__dirname, '..', 'functions', 'invoice-extract.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const PHOTO = Buffer.from('x'.repeat(2000)).toString('base64');
const POST = (b) => handler({
  httpMethod: 'POST',
  body: JSON.stringify(Object.assign(
    { store_id: 'store1', base64_image: PHOTO, mime_type: 'image/jpeg' }, b)),
});

(async () => {
  console.log('What it refuses to even try');
  let r = await handler({ httpMethod: 'GET' });
  check('GET is refused', r.statusCode, 405);
  r = await POST({ base64_image: '' });
  check('no photo is refused', r.statusCode, 400);
  r = await POST({ mime_type: 'application/pdf' });
  check('a PDF is refused with a plain reason', r.statusCode, 400);
  checkTrue('and says to use a photo',
    JSON.parse(r.body).error.indexOf('photo') > -1, JSON.parse(r.body).error);
  r = await POST({ base64_image: 'A'.repeat(20 * 1024 * 1024) });
  check('an enormous photo is refused', r.statusCode, 413);

  console.log('\nA clean invoice');
  modelSays = JSON.stringify({
    vendor_name: 'Pac Agri Foods', invoice_number: '884412', invoice_date: '2026-10-27',
    subtotal: 9000, tax: 0, freight: 473.14, total: 9473.14,
    terms_text: 'NET 15', line_count: 42, unreadable: [],
  });
  r = await POST({});
  let b = JSON.parse(r.body);
  check('accepted', r.statusCode, 200);
  check('vendor', b.draft.vendor_name, 'Pac Agri Foods');
  check('total', b.draft.total, 9473.14);
  check('date', b.draft.invoice_date, '2026-10-27');
  checkTrue('the vendor is recognised', b.vendor.known === true);
  check('and their terms come with it', b.vendor.terms_code, 'net15');
  check('nothing needs a second look', b.needs_eyes, false);

  console.log('\nIt never saves anything by itself');
  check('no invoice was created', DB.invoices.length, 1);

  console.log('\nWhen the arithmetic on the page does not agree');
  modelSays = JSON.stringify({
    vendor_name: 'Pac Agri Foods', invoice_number: '884413', invoice_date: '2026-10-27',
    subtotal: 9000, tax: 100, freight: 50, total: 9999.99, unreadable: [],
  });
  b = JSON.parse((await POST({})).body);
  checkTrue('it says the parts do not add up',
    b.draft.unreadable.some((u) => u.indexOf('add up to') > -1), JSON.stringify(b.draft.unreadable));
  check('and flags it for a human', b.needs_eyes, true);

  console.log('\nWhen something is unreadable');
  modelSays = JSON.stringify({
    vendor_name: 'Pac Agri Foods', invoice_number: null, invoice_date: null,
    subtotal: null, tax: null, freight: null, total: null,
    unreadable: ['total: the bottom of the page is cut off'],
  });
  b = JSON.parse((await POST({})).body);
  check('the total comes back null, not a guess', b.draft.total, null);
  check('flagged', b.needs_eyes, true);
  checkTrue('and says why', b.draft.unreadable[0].indexOf('cut off') > -1);

  console.log('\nAn invoice already on file');
  modelSays = JSON.stringify({
    vendor_name: 'Pac Agri Foods', invoice_number: '971039', invoice_date: '2026-10-20',
    subtotal: 9473.14, tax: 0, freight: 0, total: 9473.14, unreadable: [],
  });
  b = JSON.parse((await POST({})).body);
  checkTrue('the duplicate is found', !!b.duplicate, JSON.stringify(b.duplicate));
  check('with what was recorded before', b.duplicate.total_amount, 9473.14);
  check('and it is flagged', b.needs_eyes, true);

  console.log('\nMessy output from the model');
  modelSays = 'Here is the invoice:\n```json\n' + JSON.stringify({
    vendor_name: 'New Produce Co', total: 1200.5, unreadable: [],
  }) + '\n```';
  b = JSON.parse((await POST({})).body);
  check('JSON is still recovered', b.draft.total, 1200.5);
  check('an unknown vendor is reported as unknown', b.vendor.known, false);

  modelSays = 'I cannot read this image at all.';
  r = await POST({});
  check('unusable output is an error, not a blank invoice', r.statusCode, 502);

  console.log('\nCurrency and separators');
  modelSays = JSON.stringify({ vendor_name: 'X', total: '$9,473.14', unreadable: [] });
  b = JSON.parse((await POST({})).body);
  check('a formatted number is read correctly', b.draft.total, 9473.14);

  console.log('\nA credit memo');
  modelSays = JSON.stringify({ vendor_name: 'X', total: -250.75, unreadable: [] });
  b = JSON.parse((await POST({})).body);
  check('a negative total survives', b.draft.total, -250.75);

  console.log('\nWhen the vision service is down');
  modelFails = true;
  r = await POST({});
  check('it fails loudly', r.statusCode, 502);
  checkTrue('and does not pretend to have read anything',
    JSON.parse(r.body).draft === undefined);
  modelFails = false;

  console.log('\nThe request it actually sends');
  await POST({});
  checkTrue('an image is attached',
    lastRequest.body.messages[0].content.some((c) => c.type === 'image'));
  checkTrue('the model is a real one',
    /^claude-(opus|sonnet|haiku)-\d/.test(lastRequest.body.model), lastRequest.body.model);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

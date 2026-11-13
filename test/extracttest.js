// Tests invoice-extract. The point of these is that a number read off a
// photograph is never quietly trusted.

const path = require('path');
const Module = require('module');
// Signed in. The endpoints refuse anyone who is not; that is tested on
// its own in authtest, not again in every suite.
require('./stub-guard');

const DB = {
  scans: [],
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
  let mode = null;
  let payload = null;
  const api = {
    select() { return api; },
    insert(p) { mode = 'insert'; payload = p; return api; },
    update(p) { mode = 'update'; payload = p; return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    neq(col, val) { rows = rows.filter((r) => r[col] !== val); return api; },
    ilike(col, pattern) {
      const needle = pattern.replace(/%/g, '').toLowerCase();
      rows = rows.filter((r) => String(r[col] || '').toLowerCase().includes(needle));
      return api;
    },
    is(col, v) { rows = rows.filter((r) => (v === null ? r[col] == null : r[col] === v)); return api; },
    in(col, vs) { rows = rows.filter((r) => vs.indexOf(r[col]) > -1); return api; },
    order() { return api; },
    limit(n) { rows = rows.slice(0, n); return api; },
    maybeSingle() { return finish(true); },
    single() { return finish(true); },
    then(res) { return finish(false).then(res); },
  };
  function finish(one) {
    if (mode === 'insert') {
      const r = Object.assign({ scan_id: 'scan-' + ((DB[table] || []).length + 1) }, payload);
      if (!DB[table]) DB[table] = [];
      DB[table].push(r);
      return Promise.resolve({ data: one ? r : [r], error: null });
    }
    if (mode === 'update') {
      rows.forEach((r) => Object.assign(r, payload));
      return Promise.resolve({ data: rows, error: null });
    }
    return Promise.resolve({ data: one ? (rows[0] || null) : rows, error: null });
  }
  return api;
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB5';
  return origResolve.call(this, request, ...rest);
};
const storage = {
  from() {
    return {
      upload: async (p) => ({ data: { path: p }, error: null }),
      remove: async () => ({ error: null }),
      createSignedUrl: async (p) => ({ data: { signedUrl: 'https://s/' + p }, error: null }),
      // The reader fetches the photograph itself now.
      download: async () => ({
        data: { arrayBuffer: async () => Buffer.from('photo-bytes') }, error: null,
      }),
    };
  },
};
require.cache.MOCK_SB5 = {
  id: 'MOCK_SB5', filename: 'MOCK_SB5', loaded: true,
  exports: { createClient: () => ({ from: query, storage: storage }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';

// Stand in for the vision call. Each test sets what the model "saw".
let modelSays = null;
let modelFails = false;
let lastRequest = null;
// The reading moved to a background function, so the honest way to test
// invoice-extract is to let that function actually run against the same
// fake database -- which is exactly what happens in production, only
// without the network in between.
let background = null;
const JOBS = [];
let refuseJob = 0;
global.fetch = async (url, options) => {
  if (String(url).indexOf('paper-read-background') > -1) {
    JOBS.push({ body: options.body, headers: options.headers });
    // The platform refusing the job, which is what happened for six days.
    if (refuseJob) {
      return { ok: false, status: refuseJob, json: async () => ({}), text: async () => '' };
    }
    if (!background) {
      background = require(
        path.join(__dirname, '..', 'functions', 'paper-read-background.js')).handler;
    }
    // Run it, and wait, so the row is filled before the caller looks.
    await background({
      httpMethod: 'POST',
      headers: options.headers,
      body: options.body,
    });
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
  }

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

  // -------------------------------------------------------------------
  // The job must never carry the photograph
  //
  // This is the regression that cost him six days of typing invoices in
  // by hand. A Netlify background function is an ASYNCHRONOUS Lambda
  // invocation, and those accept 256 KB of payload -- not the 6 MB a
  // synchronous function accepts. Posting the base64 image made the body
  // roughly 2 MB for a 1.5 MB photo, so the platform answered 413 in
  // under a fifth of a second, every time, before a line of the reader
  // ran.
  //
  // Nothing about it was visible. The scan row said "reading" for ever,
  // no error was written anywhere, and the only symptom was that
  // scanning quietly stopped working.
  //
  // The size of the job is now a tested property rather than something
  // to remember: a photograph may be any size, the job may not grow
  // with it.
  console.log('\nThe job that is handed over');
  JOBS.length = 0;
  const BIG = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
  await POST({ base64_image: BIG });
  const job = JOBS[0];
  checkTrue('a job is handed over', !!job);
  const kb = Math.round(Buffer.byteLength(job ? job.body : '', 'utf8') / 1024);
  checkTrue('the job stays far under the 256 KB async-invoke limit', kb < 200, kb + ' KB');
  const parsed = JSON.parse(job ? job.body : '{}');
  checkTrue('it names the scan to read', !!parsed.scan_id);
  checkTrue('the photograph does NOT travel in it', parsed.base64_image === undefined);

  // The second half of the same silence: the platform's answer was never
  // looked at, so a refused job left the row saying "reading" for ever.
  console.log('\nA refused job is visible, not silent');
  JOBS.length = 0;
  refuseJob = 413;
  const refused = await POST({});
  refuseJob = 0;
  checkTrue('the caller is told', refused.statusCode !== 200, 'got ' + refused.statusCode);
  const stuck = (DB.scans || []).slice(-1)[0];
  check('the scan is marked failed, not left reading',
    stuck && stuck.read_state, 'failed');
  checkTrue('and the row says why', /too large|refused/i.test((stuck && stuck.read_error) || ''),
    (stuck && stuck.read_error) || 'no reason given');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

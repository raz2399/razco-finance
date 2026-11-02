// Keeping the photograph.
//
// Until now a photographed invoice was read for its figures and thrown
// away. The numbers survived; the evidence did not. When a vendor
// disputes what was delivered in March, the answer was "the system says
// so" — which is the system's opinion of a piece of paper nobody kept.
//
// The rule this suite exists to pin: the photo is saved BEFORE it is
// read, and kept whatever the reading does. A version that saves after
// a successful read loses exactly the photographs most worth having —
// the ones where the reading failed, so the picture is all that is left.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
require('./stub-guard');

const ROOT = path.join(__dirname, '..');

let UPLOADED;
let REMOVED;
let ROWS;
let failUpload;
let failInsert;
let modelFails;

function reset() {
  UPLOADED = [];
  REMOVED = [];
  ROWS = [];
  failUpload = false;
  failInsert = false;
  modelFails = false;
}

const storage = {
  from() {
    return {
      upload(p, bytes, opts) {
        if (failUpload) return Promise.resolve({ error: { message: 'bucket is full' } });
        UPLOADED.push({ path: p, bytes: bytes.length, type: opts && opts.contentType });
        return Promise.resolve({ data: { path: p }, error: null });
      },
      remove(paths) {
        REMOVED.push.apply(REMOVED, paths);
        return Promise.resolve({ error: null });
      },
      createSignedUrl(p) {
        return Promise.resolve({ data: { signedUrl: 'https://signed/' + p }, error: null });
      },
    };
  },
};

function table(name) {
  let rows = name === 'scans' ? ROWS.slice() : [];
  let mode = null;
  let payload = null;

  const api = {
    select() { return api; },
    insert(p) { mode = 'insert'; payload = p; return api; },
    update(p) { mode = 'update'; payload = p; return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    ilike(col, val) {
      const needle = String(val).replace(/%/g, '').toLowerCase();
      rows = rows.filter((r) => String(r[col] || '').toLowerCase().indexOf(needle) > -1);
      return api;
    },
    or() { return api; },
    gte() { return api; },
    lte() { return api; },
    neq() { return api; },
    is() { return api; },
    not() { return api; },
    in() { return api; },
    order() { return api; },
    limit() { return api; },
    range() { return api; },
    maybeSingle() { return finish(true); },
    single() { return finish(true); },
    then(resolve) { return finish(false).then(resolve); },
  };

  function finish(one) {
    if (mode === 'insert') {
      if (failInsert) {
        return Promise.resolve({ data: null, error: { message: 'row rejected' } });
      }
      const r = Object.assign({ scan_id: 'scan-' + (ROWS.length + 1) }, payload);
      ROWS.push(r);
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

const orig = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => ({ from: table, storage: storage }) };
  }
  return orig.apply(this, arguments);
};

process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'k';
process.env.ANTHROPIC_API_KEY = 'test-key';

// The model call, stubbed. Its failure is the case that matters most.
global.fetch = () => {
  if (modelFails) {
    return Promise.resolve({
      ok: false,
      text: () => Promise.resolve('model is down'),
    });
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      content: [{
        type: 'text',
        text: JSON.stringify({
          vendor_name: 'Sysco', invoice_number: '4471',
          total: 708.19, invoice_date: '2026-10-30', unreadable: [],
        }),
      }],
    }),
  });
};

const { handler } = require(path.join(ROOT, 'functions', 'invoice-extract.js'));
const { keep } = require(path.join(ROOT, 'functions', 'lib', 'keepscan.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass += 1; console.log('  ok   ' + name); })
    .catch((e) => { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); });
}

const PHOTO = Buffer.from('a pretend jpeg, long enough to be real').toString('base64');

const send = (over) => handler({
  httpMethod: 'POST',
  headers: { authorization: 'Bearer t' },
  queryStringParameters: {},
  body: JSON.stringify(Object.assign({
    store_id: 'store1', kind: 'invoice',
    base64_image: PHOTO, mime_type: 'image/jpeg',
  }, over)),
}).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

console.log('\nevery photograph is kept');

Promise.resolve()
  .then(() => check('a photo that reads fine is kept', () => {
    reset();
    return send().then((r) => {
      assert.strictEqual(r.status, 200, r.body.error);
      assert.strictEqual(UPLOADED.length, 1, 'nothing was uploaded');
      assert.strictEqual(r.body.scan_kept, true);
      assert.ok(r.body.scan_id, 'the reply must say which scan it is');
    });
  }))

  .then(() => check('a photo whose READING FAILS is still kept', () => {
    // The case the whole design is for. The figures are gone, so the
    // picture is the only thing left.
    reset();
    modelFails = true;
    return send().then((r) => {
      assert.strictEqual(UPLOADED.length, 1,
        'the reading failed and the photo was thrown away with it');
      assert.strictEqual(r.body.scan_kept, true);
      assert.ok(/saved/.test(r.body.error), 'it should say the photo survived: ' + r.body.error);
    });
  }))

  .then(() => check('the upload happens BEFORE the read, not after', () => {
    reset();
    modelFails = true;
    return send().then(() => {
      assert.strictEqual(UPLOADED.length, 1);
      const src = fs.readFileSync(
        path.join(ROOT, 'functions', 'invoice-extract.js'), 'utf8');
      assert.ok(src.indexOf('const held = await keep(') < src.indexOf('api.anthropic.com'),
        'the photo must be put away before the model is called');
    });
  }))

  .then(() => check('if the photo cannot be kept, the reading still happens', () => {
    reset();
    failUpload = true;
    return send().then((r) => {
      assert.strictEqual(r.status, 200, 'a failed upload must not stop the read');
      assert.ok(r.body.draft, 'the figures should still come back');
      assert.strictEqual(r.body.scan_kept, false);
    });
  }))

  .then(() => check('and it SAYS so rather than letting him assume a copy exists', () => {
    reset();
    failUpload = true;
    return send().then((r) => {
      assert.ok(r.body.scan_note, 'silence here is the dangerous answer');
      assert.ok(/could not be saved/i.test(r.body.scan_note), r.body.scan_note);
    });
  }))

  .then(() => { console.log('\nnothing is left half-done'); })

  .then(() => check('a file with no row pointing at it is removed again', () => {
    // Otherwise the bucket fills with things nothing can find.
    reset();
    failInsert = true;
    return keep({ from: table, storage: storage }, {
      store_id: 'store1', base64: PHOTO, mime_type: 'image/jpeg', kind: 'invoice',
    }).then((r) => {
      assert.strictEqual(r.kept, false);
      assert.strictEqual(REMOVED.length, 1, 'the orphaned file was left in the bucket');
    });
  }))

  .then(() => check('a file type that cannot be kept is refused, not guessed at', () => {
    reset();
    return keep({ from: table, storage: storage }, {
      store_id: 'store1', base64: PHOTO, mime_type: 'application/zip',
    }).then((r) => {
      assert.strictEqual(r.kept, false);
      assert.strictEqual(UPLOADED.length, 0);
    });
  }))

  .then(() => check('an empty photo is refused', () => {
    reset();
    return keep({ from: table, storage: storage }, {
      store_id: 'store1', base64: '', mime_type: 'image/jpeg',
    }).then((r) => {
      assert.strictEqual(r.kept, false);
      assert.strictEqual(UPLOADED.length, 0);
    });
  }))

  .then(() => { console.log('\nwhere they go'); })

  .then(() => check('the path is dated and carries no guessable name', () => {
    reset();
    return keep({ from: table, storage: storage }, {
      store_id: 'store1', base64: PHOTO, mime_type: 'image/jpeg',
    }).then(() => {
      const p = UPLOADED[0].path;
      assert.ok(/^store1\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/.test(p),
        'path was ' + p);
    });
  }))

  .then(() => check('two photos never collide', () => {
    reset();
    const client = { from: table, storage: storage };
    return keep(client, { store_id: 'store1', base64: PHOTO, mime_type: 'image/jpeg' })
      .then(() => keep(client, { store_id: 'store1', base64: PHOTO, mime_type: 'image/jpeg' }))
      .then(() => {
        assert.strictEqual(UPLOADED.length, 2);
        assert.notStrictEqual(UPLOADED[0].path, UPLOADED[1].path);
      });
  }))

  .then(() => { console.log('\nit survives the trip to the entry it became'); })

  // Keeping the photo is only half of it. If nothing carries the id from
  // the reading through to the save, every scan ends up filed under
  // nothing -- there, but attached to no invoice, so unfindable from the
  // line it belongs to. These check the whole chain, on both screens,
  // by reading the source: there is no way to press the buttons here.

  .then(() => check('the server ties a saved invoice to its photo', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'invoices.js'), 'utf8');
    assert.ok(/require\(['"]\.\/lib\/keepscan['"]\)/.test(src),
      'invoices.js calls attach() without requiring it -- see test/undefinedtest.js');
    assert.ok(/attach\(supabase,\s*body\.scan_id,\s*['"]invoice['"]/.test(src),
      'nothing ties the invoice row to the photograph');
  }))

  .then(() => check('and a logged check to its photo', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'checks.js'), 'utf8');
    assert.ok(/require\(['"]\.\/lib\/keepscan['"]\)/.test(src), 'attach() is not required');
    assert.ok(/attach\(supabase,\s*body\.scan_id,\s*['"]payment['"]/.test(src),
      'nothing ties the check row to the photograph');
  }))

  .then(() => check('the phone carries the id from the read to the save', () => {
    const d = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'DeliveryScreen.js'), 'utf8');
    assert.ok(/scanId:\s*res\.scan_id/.test(d), 'the read result drops the scan id');
    assert.ok(/scan_id:\s*d\.scanId/.test(d), 'the save does not send it');
    const c = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'CheckScreen.js'), 'utf8');
    assert.ok(/scan_id:\s*read\s*&&\s*read\.scan_id/.test(c),
      'the check screen does not send the scan id');
  }))

  .then(() => check('a failed read on the phone still keeps hold of the photo', () => {
    // The case that pays for all of this: the reading failed, so he types
    // the figures by hand -- and the picture must still end up attached
    // to what he typed. That needs the failure to carry the id, which
    // means the error has to carry the body.
    const api = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'api.js'), 'utf8');
    assert.ok(/err\.data\s*=\s*data/.test(api),
      'a failed call throws away the body, and the scan id with it');
    const d = fs.readFileSync(path.join(ROOT, 'mobile', 'src', 'DeliveryScreen.js'), 'utf8');
    assert.ok(/e\.data\s*&&\s*e\.data\.scan_id/.test(d),
      'the catch does not pick the scan id out of the failure');
  }))

  .then(() => check('the desktop carries it too, and clears it after saving', () => {
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(/held_scan:/.test(src), 'the page holds no scan id');
    assert.ok(/payload\.scan_id = this\.held_scan\.invoice/.test(src),
      'the invoice form does not send it');
    assert.ok(/payload\.scan_id = this\.held_scan\.check/.test(src),
      'the check form does not send it');
    // Not clearing it is the quiet bug: the next invoice typed in by hand
    // would be filed against the last one's paper.
    assert.ok(/held_scan\.invoice = null/.test(src), 'the invoice form never lets go of it');
    assert.ok(/held_scan\.check = null/.test(src), 'the check form never lets go of it');
    assert.ok(/err\.data = data/.test(src), 'a failed read drops the scan id on the desktop');
  }))

  .then(() => { console.log('\nlooking one back up'); })

  .then(() => check('the ledger says which lines have paper, without minting links', () => {
    // Sixty rows painted with sixty signed links would be sixty standing
    // ways in. The ledger says only whether paper exists; the link is
    // minted when he presses the button.
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'vendor-ledger.js'), 'utf8');
    assert.ok(/has_paper/.test(src), 'the ledger does not say which lines have paper');
    assert.ok(!/createSignedUrl/.test(src),
      'the ledger is minting links for every row');
  }))

  .then(() => check('a missing scans table cannot take the ledger down', () => {
    // The ledger is the point of that endpoint. An index of photographs
    // failing must not stop him seeing what he owes.
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'vendor-ledger.js'), 'utf8');
    const at = src.indexOf("from('scans')");
    assert.ok(at > -1);
    const after = src.slice(at, at + 400);
    assert.ok(/if\s*\(!sc\.error\)/.test(after),
      'a failed scans query is not handled, so it would 500 the whole ledger');
  }))

  .then(() => check('the button opens its tab on the press, not on the answer', () => {
    // Opening it when the link arrives is what every browser blocks, and
    // it fails silently -- he presses the button and nothing happens.
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const at = src.indexOf('openPaper: function');
    assert.ok(at > -1, 'there is no way to open the paper from the ledger');
    const body = src.slice(at, at + 1600);
    assert.ok(body.indexOf("window.open('', '_blank')") < body.indexOf("this.get('/scans"),
      'the tab is opened after the fetch, which the browser will block');
  }))

  .then(() => check('the bucket is private and links expire', () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'scans.js'), 'utf8');
    assert.ok(/createSignedUrl/.test(src),
      'a permanent URL is a permanent way in for anyone who ever saw it');
    assert.ok(/requireUser/.test(src), 'and only for somebody signed in');
    const mig = fs.readFileSync(path.join(ROOT, 'functions', 'lib', 'keepscan.js'), 'utf8');
    assert.ok(/private/i.test(mig), 'the reason should be written down');
  }))

  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });

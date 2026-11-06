// Reading the paper, with no clock running.
//
// ---------------------------------------------------------------------
// Why this file exists
//
// Netlify kills a normal function at ten seconds. The reads that worked
// took 7.8 to 9.0 seconds; the reads that died took 10.6 to 12.6 and
// came back 502. Nothing was wrong with the reading. The hard invoices
// -- the three-page PacAgri with 57 cases on it, the one with a
// handwritten short note next to the shrimp line -- are exactly the ones
// that take longest, so the clock was throwing away the work that
// mattered most and leaving him to type it in by hand.
//
// A background function runs for up to fifteen minutes. Moving the model
// call here does not make the reading cleverer; it stops a correct
// answer being thrown away for arriving at eleven seconds. And it means
// the reader can be given room -- more tokens, and a second look at
// anything that comes back thin -- which a ten second budget could never
// have afforded.
//
// ---------------------------------------------------------------------
// How it hangs together
//
//   invoice-extract   saves the photo, starts this, answers at once
//   this file         reads it properly, writes the answer onto the scan
//   scans?scan_id=    the phone collects the answer when it is ready
//
// The photograph is saved before any of this, so a read that fails still
// leaves him the picture. That has not changed.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { PROMPTS, MODEL, parseModelJson } = require('./lib/readpaper');
const { matchVendorForName } = require('./lib/vendormatch');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Room to work. The old limit was 1024 and shared with a ten second
// budget; a long invoice with a list of what could not be read would run
// out of both. Neither is scarce here.
const MAX_TOKENS = 4096;

async function askTheModel(base64, mime, kind, extraNote) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
    { type: 'text', text: PROMPTS[kind] + (extraNote ? '\n\n' + extraNote : '') },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error('The reader refused the photo.');
    err.detail = detail.slice(0, 400);
    err.status = res.status;
    throw err;
  }

  const payload = await res.json();
  const text = (payload.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  return parseModelJson(text);
}

// Did that read actually tell us anything? An invoice with no vendor and
// no amount is not a reading, it is a shrug.
function tooThin(kind, data) {
  if (!data) return true;
  if (kind === 'check') {
    return data.amount_numeric == null && data.amount_written == null;
  }
  if (kind === 'statement') return !data.lines || !data.lines.length;
  return !data.vendor_name && data.total == null;
}

// ---------------------------------------------------------------------
// Who is allowed to start a read
//
// A background function has a public URL like any other. Nobody signs in
// to this one -- it is started by invoice-extract, which has already
// checked who the user is -- so without a lock on the door anybody who
// found the address could post photographs at it all day and spend his
// money on reading them.
//
// So the job is signed. invoice-extract stamps it with the same service
// key the rest of the back end holds, and this refuses anything that is
// not stamped, or stamped over five minutes ago. Compared the slow way
// on purpose: a plain === leaks, a character at a time, how much of a
// guess was right.
function stampFor(body) {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || '')
    .update(body).digest('hex');
}

function stampIsGood(rawBody, stamp, sentAt) {
  if (!stamp || !sentAt) return false;
  const age = Date.now() - Number(sentAt);
  if (!(age >= -30000 && age < 5 * 60 * 1000)) return false;
  const want = Buffer.from(stampFor(sentAt + '.' + rawBody));
  const got = Buffer.from(String(stamp));
  if (want.length !== got.length) return false;
  return crypto.timingSafeEqual(want, got);
}

exports.handler = async (event) => {
  // Background functions answer 202 before this runs, so nothing here is
  // waited on by anybody. Everything it learns goes onto the scan row.
  const raw = event.body || '{}';
  const h = event.headers || {};
  if (!stampIsGood(raw, h['x-razi-stamp'] || h['X-Razi-Stamp'],
                   h['x-razi-at'] || h['X-Razi-At'])) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not signed.' }) };
  }

  let job;
  try {
    job = JSON.parse(raw);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad job.' }) };
  }

  const { scan_id, store_id, kind, base64_image, mime_type } = job;
  if (!scan_id || !base64_image) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to read.' }) };
  }

  const finish = async (patch) => {
    try {
      await supabase.from('scans').update(patch).eq('scan_id', scan_id);
    } catch (e) { /* the photograph is kept either way */ }
  };

  try {
    let data = await askTheModel(base64_image, mime_type, kind);

    // A second look at anything that came back empty-handed.
    //
    // This is the part a ten second budget could never have paid for,
    // and it is aimed squarely at the invoices he has been typing in by
    // hand: a photograph at an angle, a carbon copy, a total written on
    // in biro. Telling the reader that the first pass found nothing, and
    // where to look, gets a usable answer out of most of them.
    if (tooThin(kind, data)) {
      const second = await askTheModel(base64_image, mime_type, kind,
        'A first pass found almost nothing on this photograph. Look again, '
        + 'carefully, and assume it IS readable. It may be creased, at an '
        + 'angle, a carbon copy, lit badly, or part covered by a thumb. The '
        + 'total may be handwritten beside or instead of the printed one -- '
        + 'if a figure is written on by hand, that is the amount payable and '
        + 'the printed one is not. The vendor may only appear in small print '
        + 'in a header, a footer, a remit-to block, or a logo. Give every '
        + 'field you can make out, and list only what truly cannot be read.');
      if (!tooThin(kind, second)) data = second;
      else if (second) data = Object.assign({}, second, data);
    }

    // Who this is, against his own vendor list -- worked out here so the
    // phone is handed an answer rather than a name to retype.
    let matched = null;
    if (kind === 'invoice' && data && data.vendor_name) {
      matched = await matchVendorForName(supabase, store_id, data.vendor_name);
    }
    if (kind === 'check' && data && data.payee) {
      matched = await matchVendorForName(supabase, store_id, data.payee);
    }

    await finish({
      extracted: data,
      read_state: 'done',
      read_vendor_id: matched ? matched.vendor_id : null,
      read_error: null,
    });
    return { statusCode: 200 };
  } catch (err) {
    await finish({
      read_state: 'failed',
      read_error: (err && err.message) || 'The reader could not be reached.',
    });
    return { statusCode: 200 };
  }
};

// Keeping the photograph.
//
// ---------------------------------------------------------------------
// The rule
//
// Every photograph is kept, whatever happens next. Before the reading,
// not after. A photo whose reading FAILED is the one most worth having
// -- the figures are gone, so the picture is all that is left -- and any
// version of this that saves after a successful read loses exactly
// those.
//
// So: upload first, then read. If the upload fails the reading still
// goes ahead, because a photograph that was read is better than nothing
// at all; the reply says plainly that it was not kept, rather than
// letting him believe there is a copy when there is not.
//
// ---------------------------------------------------------------------
// Where they go
//
// A private bucket. These are invoices with vendor names, account
// numbers and prices on them. Nothing about them should be reachable by
// anybody holding a URL, which is why reading one back goes through a
// signed link that expires.
//
// Paths are store/year/month/uuid. Dated, so a year of them can be
// found or pruned without opening any of them.

const crypto = require('crypto');

const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

const BUSINESS_TZ = 'America/Los_Angeles';

function pathFor(store_id, mime) {
  // Pacific, so a photo taken at 7pm files under that day rather than
  // tomorrow -- the same rule the rest of the system uses for dates.
  const day = new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  const safeStore = String(store_id || 'store').replace(/[^a-zA-Z0-9_-]/g, '');
  return safeStore + '/' + day.slice(0, 4) + '/' + day.slice(5, 7) + '/'
    + crypto.randomUUID() + '.' + (EXT[mime] || 'bin');
}

/**
 * Put one photograph away and write down that it exists.
 *
 * Never throws. Returns { kept: true, scan_id, path } or
 * { kept: false, why } -- the caller carries on either way, and tells
 * him which happened.
 */
async function keep(supabase, opts) {
  const store_id = opts.store_id;
  const base64 = opts.base64;
  const mime = opts.mime_type;

  if (!base64 || !EXT[mime]) {
    return { kept: false, why: 'Not a kind of file that can be kept.' };
  }

  let bytes;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch (e) {
    return { kept: false, why: 'The photo could not be decoded.' };
  }
  if (!bytes.length) return { kept: false, why: 'The photo was empty.' };

  const path = pathFor(store_id, mime);

  try {
    const up = await supabase.storage.from('scans').upload(path, bytes, {
      contentType: mime,
      upsert: false,
    });
    if (up.error) return { kept: false, why: up.error.message };
  } catch (e) {
    return { kept: false, why: (e && e.message) || 'Could not store the photo.' };
  }

  const row = {
    store_id: store_id,
    path: path,
    mime_type: mime,
    bytes: bytes.length,
    kind: opts.kind || 'invoice',
    taken_by: opts.taken_by || null,
  };

  try {
    const ins = await supabase.from('scans').insert(row).select('scan_id, path').single();
    if (ins.error) {
      // The file is in the bucket with no row pointing at it. Removed,
      // so the bucket does not fill with things nothing can find.
      try { await supabase.storage.from('scans').remove([path]); } catch (e2) { /* nothing more to do */ }
      return { kept: false, why: ins.error.message };
    }
    return { kept: true, scan_id: ins.data.scan_id, path: ins.data.path };
  } catch (e) {
    try { await supabase.storage.from('scans').remove([path]); } catch (e2) { /* nothing more to do */ }
    return { kept: false, why: (e && e.message) || 'Could not record the photo.' };
  }
}

/**
 * Say what the reader made of it, after the fact.
 *
 * Kept verbatim so a later dispute can see what the machine thought at
 * the time, not what the figures were edited to afterwards.
 */
async function noteReading(supabase, scan_id, extracted) {
  if (!scan_id) return;
  try {
    await supabase.from('scans').update({ extracted: extracted }).eq('scan_id', scan_id);
  } catch (e) { /* the photograph is kept either way */ }
}

/**
 * Tie a photograph to whatever was eventually saved from it.
 */
async function attach(supabase, scan_id, entity_type, entity_id) {
  if (!scan_id || !entity_id) return false;
  if (entity_type !== 'invoice' && entity_type !== 'payment') return false;
  try {
    const r = await supabase.from('scans')
      .update({ entity_type: entity_type, entity_id: entity_id })
      .eq('scan_id', scan_id);
    return !r.error;
  } catch (e) {
    return false;
  }
}

/**
 * A row with no photograph behind it.
 *
 * Storage failing should cost him the picture, not the figures. The row
 * is the mailbox the reading gets delivered to; the file is only the
 * photo. Keeping those two separate means a bad minute for the bucket
 * does not also mean he has to type the invoice in by hand.
 */
async function keepRowOnly(supabase, opts) {
  try {
    const ins = await supabase.from('scans').insert({
      store_id: opts.store_id,
      path: null,
      mime_type: opts.mime_type || null,
      bytes: 0,
      kind: opts.kind || 'invoice',
      taken_by: opts.taken_by || null,
    }).select('scan_id').single();
    if (ins.error) return { kept: false, why: ins.error.message };
    return { kept: false, scan_id: ins.data.scan_id, no_photo: true };
  } catch (e) {
    return { kept: false, why: (e && e.message) || 'Could not record the photo.' };
  }
}

module.exports = { keep, keepRowOnly, noteReading, attach, pathFor, EXT };

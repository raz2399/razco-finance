// Netlify Function: scans
// Looking a photograph back up.
//
//   GET ?store_id=store1&entity_type=invoice&entity_id=<uuid>
//        -> the photographs of that line, with links that open them
//   GET ?store_id=store1&unattached=1
//        -> the ones nobody ever saved anything from
//   GET ?store_id=store1&scan_id=<uuid>  -> one, with a link
//
// ---------------------------------------------------------------------
// Why links expire
//
// The bucket is private: these are invoices with vendor names, account
// numbers and prices on them. A permanent URL would be a permanent way
// in for anybody who ever saw it -- in a chat message, a browser
// history, a screenshot. So nothing has a lasting address. Asking for a
// scan mints a link good for an hour, and asking again mints another.
//
// The check happens here, where the session is: the link is only minted
// for somebody already signed in and already entitled to that store.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const AN_HOUR = 60 * 60;

async function linkFor(path) {
  try {
    const r = await supabase.storage.from('scans').createSignedUrl(path, AN_HOUR);
    if (r.error) return null;
    return (r.data && r.data.signedUrl) || null;
  } catch (e) {
    return null;
  }
}

exports.handler = safely('scans', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const store_id = q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  // Collecting a reading that was still going when the phone asked.
  //
  // A hard invoice takes longer than the ten seconds Netlify allows, so
  // the reading happens in the background and the answer lands here.
  // This is how the phone finds out it is ready.
  if (q.waiting_on) {
    const r = await supabase
      .from('scans')
      .select('scan_id, kind, extracted, read_state, read_error, read_vendor_id')
      .eq('store_id', store_id).eq('scan_id', q.waiting_on)
      .maybeSingle();
    if (r.error) return json(500, { error: r.error.message });
    if (!r.data) return json(404, { error: 'No such scan.' });
    // The vendor comes back in the same shape invoice-extract uses, so
    // the screen does not have to know which of the two paths answered.
    // Two shapes for one thing is two things, and they drift.
    let vendor = { known: false };
    if (r.data.read_vendor_id) {
      const v = await supabase.from('vendors')
        .select('vendor_id, name, payment_type, terms_code, terms_days')
        .eq('store_id', store_id).eq('vendor_id', r.data.read_vendor_id)
        .maybeSingle();
      if (v.data) {
        vendor = {
          vendor_id: v.data.vendor_id,
          name: v.data.name,
          pay_method: v.data.payment_type,
          terms_code: v.data.terms_code,
          terms_days: v.data.terms_days,
          known: true,
        };
      }
    }

    return json(200, {
      ok: true,
      scan_id: r.data.scan_id,
      kind: r.data.kind,
      still_reading: r.data.read_state === 'reading',
      failed: r.data.read_state === 'failed',
      why: r.data.read_error || null,
      extracted: r.data.extracted || null,
      draft: r.data.extracted || null,
      vendor: vendor,
      vendor_id: r.data.read_vendor_id || null,
    });
  }

  let query = supabase
    .from('scans')
    .select('scan_id, path, mime_type, bytes, kind, entity_type, entity_id, taken_by, created_at')
    .eq('store_id', store_id)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(q.limit) || 50, 200));

  if (q.scan_id) {
    query = query.eq('scan_id', q.scan_id);
  } else if (q.entity_id) {
    query = query.eq('entity_id', q.entity_id);
    if (q.entity_type) query = query.eq('entity_type', q.entity_type);
  } else if (q.unattached) {
    // Photographs nobody ever saved anything from. Usually a reading
    // that went wrong, which makes them the ones most worth finding.
    query = query.is('entity_id', null);
  }

  const res = await query;
  if (res.error) return json(500, { error: res.error.message });

  const rows = res.data || [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    out.push({
      scan_id: r.scan_id,
      kind: r.kind,
      mime_type: r.mime_type,
      bytes: r.bytes,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      taken_by: r.taken_by,
      taken_at: r.created_at,
      // Good for an hour. Ask again for another.
      url: await linkFor(r.path),
      expires_in: AN_HOUR,
    });
  }

  return json(200, {
    ok: true,
    count: out.length,
    scans: out,
    note: 'These links last an hour. The photographs themselves are kept.',
  });
});

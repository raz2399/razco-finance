// A stack of invoices, followed as one job.
//
// ---------------------------------------------------------------------
// What this is for
//
// The driver leaves twelve bills on the counter. Photographing them one
// at a time, waiting for each to read, then saving each, is the work he
// has been complaining about -- and most of the waiting buys nothing,
// because the reading happens on another machine and twelve can run at
// once as easily as one.
//
// So the phone sends twelve photographs without waiting for any of
// them, and this watches the whole stack: what has been read, what is
// still going, what could not be read, and the one number that matters
// while he is standing there -- how much the pile comes to.
//
// ---------------------------------------------------------------------
// Why it refuses to save for him
//
// It will say a draft is ready and it will say when a draft looks
// wrong, but saving twelve bills into his books on one press is not a
// convenience, it is twelve chances to enter a figure nobody read. The
// ones it is sure of are marked ready, and the ones it is not are
// marked with the reason, so the pass he makes over the list is short
// rather than absent.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { linesFrom, linesCover } = require('./lib/lines');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dollars = (n) => '$' + money(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * What still has to be true before a draft can be saved without looking.
 *
 * Deliberately strict. A bill saved with the wrong total is money owed
 * that nobody owes, and it is found out weeks later by a vendor, which
 * is the most expensive way to find anything out.
 */
function readiness(scan, vendorKnown) {
  const got = scan.extracted || {};
  const missing = [];

  if (!vendorKnown) missing.push('whose it is');
  if (got.total === null || got.total === undefined) missing.push('the total');
  if (!got.invoice_number) missing.push('the invoice number');

  // The reader is told to list what it could not make out. Anything it
  // names there is something he should look at himself.
  const unread = Array.isArray(got.unreadable) ? got.unreadable.filter(Boolean) : [];

  return {
    ready: missing.length === 0 && unread.length === 0,
    missing: missing,
    unreadable: unread,
  };
}

exports.handler = safely('scan-batch', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const store_id = q.store_id;
  const batch_id = q.batch_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });
  if (!batch_id) return json(400, { error: 'Which stack?' });

  const got = await supabase.from('scans')
    .select('scan_id, batch_position, kind, read_state, read_error, extracted, read_vendor_id, bytes, created_at, read_attempts')
    .eq('store_id', store_id).eq('batch_id', batch_id)
    .order('batch_position', { ascending: true });
  if (got.error) return json(500, { error: got.error.message });

  const scans = got.data || [];
  if (!scans.length) {
    return json(404, { error: 'No photos in that stack.' });
  }

  const vendors = await supabase.from('vendors')
    .select('vendor_id, name').eq('store_id', store_id);
  const vName = {};
  (vendors.data || []).forEach((v) => { vName[v.vendor_id] = v.name; });

  // Invoice numbers already on the books, so a bill photographed twice
  // -- or photographed again next week -- is caught here rather than
  // paid twice.
  const already = await supabase.from('invoices')
    .select('invoice_id, invoice_number, vendor_id, total_amount')
    .eq('store_id', store_id).neq('status', 'void');
  const seen = {};
  (already.data || []).forEach((i) => {
    if (i.invoice_number) {
      seen[String(i.invoice_number).toUpperCase().replace(/[^A-Z0-9]/g, '')] = i;
    }
  });

  const withinBatch = {};
  const rows = scans.map((s) => {
    const got2 = s.extracted || {};
    const vendor = s.read_vendor_id ? vName[s.read_vendor_id] || null : null;
    const state = s.read_state;

    const out = {
      scan_id: s.scan_id,
      position: s.batch_position,
      state: state,
      error: s.read_error || null,
      attempts: s.read_attempts || 0,
      vendor: vendor,
      vendor_id: s.read_vendor_id || null,
      vendor_on_paper: got2.vendor_name || null,
      invoice_number: got2.invoice_number || null,
      invoice_date: got2.invoice_date || null,
      due_date: got2.due_date || null,
      total: got2.total === undefined ? null : got2.total,
      ready: false,
      missing: [],
      unreadable: [],
      duplicate_of: null,
      lines: 0,
      lines_cover_bill: null,
    };

    if (state !== 'done') return out;

    const r = readiness(s, !!s.read_vendor_id);
    out.ready = r.ready;
    out.missing = r.missing;
    out.unreadable = r.unreadable;

    const parsed = linesFrom(got2, s.scan_id);
    out.lines = parsed.kept;
    out.lines_suspect = parsed.suspect;
    if (parsed.kept) {
      const cover = linesCover(parsed.lines, got2);
      out.lines_cover_bill = cover.checked ? cover.covered : null;
    }

    // Already on the books, or twice in this same stack. The second is
    // easy to do: the driver hands over a copy, or a page gets
    // photographed twice while he works down the pile.
    const key = out.invoice_number
      ? String(out.invoice_number).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
    if (key) {
      if (seen[key]) {
        out.duplicate_of = 'already on the books';
        out.ready = false;
      } else if (withinBatch[key]) {
        out.duplicate_of = 'photo ' + withinBatch[key] + ' in this stack';
        out.ready = false;
      } else {
        withinBatch[key] = (s.batch_position || 0) + 1;
      }
    }

    return out;
  });

  const counts = {
    total: rows.length,
    reading: rows.filter((r) => r.state === 'reading').length,
    done: rows.filter((r) => r.state === 'done').length,
    failed: rows.filter((r) => r.state === 'failed').length,
    ready: rows.filter((r) => r.ready).length,
    needs_you: rows.filter((r) => r.state === 'done' && !r.ready).length,
    duplicates: rows.filter((r) => r.duplicate_of).length,
  };

  const pile = money(rows
    .filter((r) => r.state === 'done' && !r.duplicate_of && r.total)
    .reduce((t, r) => t + money(r.total), 0));

  const finished = counts.reading === 0;

  let says;
  if (!finished) {
    says = counts.done + ' of ' + counts.total + ' read so far.';
  } else if (counts.failed || counts.needs_you || counts.duplicates) {
    const bits = [];
    if (counts.ready) bits.push(counts.ready + ' ready to save');
    if (counts.needs_you) bits.push(counts.needs_you + ' want a look');
    if (counts.duplicates) {
      bits.push(counts.duplicates + ' already entered'
        + (counts.duplicates === 1 ? '' : ' or photographed twice'));
    }
    if (counts.failed) bits.push(counts.failed + ' could not be read');
    says = bits.join(', ') + '.';
  } else {
    says = 'All ' + counts.total + ' read and ready — ' + dollars(pile) + ' in the stack.';
  }

  return json(200, {
    ok: true,
    batch_id: batch_id,
    finished: finished,
    counts: counts,
    pile_total: pile,
    scans: rows,
    says: says,
  });
});

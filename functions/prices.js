// What his wholesalers have quietly changed.
//
// Reads the product lines off his invoices and reports the case prices
// that have moved since the delivery before. The judgement — what counts
// as a move worth his morning, and which comparisons must be refused —
// lives in lib/pricewatch.js so it can be tested without his books.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { priceMoves, summarise } = require('./lib/pricewatch');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

async function readAll(table, columns, shape) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await shape(supabase.from(table).select(columns)).range(from, from + 999);
    if (res.error) throw new Error(table + ': ' + res.error.message);
    const got = res.data || [];
    out.push.apply(out, got);
    if (got.length < 1000) return out;
  }
}

exports.handler = safely('prices', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const store_id = q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  const days = Math.min(Math.max(Number(q.days) || 120, 14), 400);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const [invoices, vendors] = await Promise.all([
    readAll('invoices', 'invoice_id, vendor_id, invoice_date, status',
      (p) => p.eq('store_id', store_id).gte('invoice_date', since).neq('status', 'void')),
    readAll('vendors', 'vendor_id, name', (p) => p.eq('store_id', store_id)),
  ]);

  if (!invoices.length) {
    return json(200, {
      ok: true, moves: [], lines_seen: 0, invoices_with_lines: 0,
      says: 'No invoices in this stretch yet.',
    });
  }

  const vName = {};
  vendors.forEach((v) => { vName[v.vendor_id] = v.name; });
  const invById = {};
  invoices.forEach((i) => { invById[i.invoice_id] = i; });

  // Supabase caps an `in` list, so the invoice ids go over in batches.
  const ids = Object.keys(invById);
  const lines = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const got = await readAll('invoice_lines',
      'line_id, invoice_id, code, description, pack, quantity, unit_cost, line_total, figures_disagree',
      (p) => p.in('invoice_id', batch));
    lines.push.apply(lines, got);
  }

  // The vendor and the date come off the invoice, so a line cannot be
  // compared against another vendor's by accident.
  const withContext = lines.map((l) => {
    const inv = invById[l.invoice_id] || {};
    return Object.assign({}, l, {
      vendor_id: inv.vendor_id,
      vendor: vName[inv.vendor_id] || null,
      invoice_date: inv.invoice_date,
    });
  }).filter((l) => l.vendor_id && l.invoice_date);

  const moves = priceMoves(withContext, {
    min_pct: Number(q.min_pct) || undefined,
    min_dollars: Number(q.min_dollars) || undefined,
  });

  const covered = {};
  lines.forEach((l) => { covered[l.invoice_id] = true; });
  const withLines = Object.keys(covered).length;

  return json(200, {
    ok: true,
    since: since,
    days: days,
    moves: moves,
    lines_seen: lines.length,
    invoices_with_lines: withLines,
    invoices_seen: invoices.length,
    // Said plainly, because the watch is only as good as its coverage and
    // an empty report means two completely different things: nothing
    // moved, or nothing was read.
    says: !lines.length
      ? 'No invoice lines on file yet, so there is nothing to compare. Lines '
        + 'are read from the photo when you snap an invoice, so this fills up '
        + 'as you scan.'
      : summarise(moves) + ' Read from ' + withLines + ' of '
        + invoices.length + ' invoices.',
  });
});

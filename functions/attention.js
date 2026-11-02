// Netlify Function: attention
// The things that need a person.
//
// Route: /.netlify/functions/attention
//   GET  ?store_id=store1[&all=1]   -> what is open, worst first
//   POST { exception_id, action: 'resolve'|'reopen', note }
//
// ---------------------------------------------------------------------
// Why this exists
//
// The system has been raising exceptions into a table for months and
// nothing has ever read them back. A check that cleared for the wrong
// amount, a payment that failed, a figure that did not reconcile -- all
// of it written down carefully and shown to nobody.
//
// A warning nobody reads is worse than no warning, because it creates
// the impression that something is watching.
//
// So: one endpoint, read by the phone and the desktop, ordered by how
// much it matters rather than when it happened. Critical first, because
// a $24,000 check that cleared for the wrong amount does not become less
// urgent than a $12 one by being older.

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

// Worst first. info is real but it is not an interruption.
const RANK = { critical: 0, warn: 1, info: 2 };

// Plain words for codes that are otherwise only meaningful to the code
// that raised them. A person reading their phone at 6am should not have
// to know what 'check_amount_differs' means.
const HEADLINE = {
  check_amount_differs: 'A check cleared for the wrong amount',
  check_returned_unpaid: 'A check came back unpaid',
  check_not_in_books: 'A check cleared that is not in the books',
  duplicate_check: 'The same check number twice',
  ambiguous_invoice: 'Two bills it could have paid',
};

exports.handler = safely('attention', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { body = {}; }
  }
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  // ---------------- deal with one -------------------------------------
  if (event.httpMethod === 'POST') {
    const id = body.exception_id;
    if (!id) return json(400, { error: 'Which one?' });
    const action = body.action || 'resolve';
    if (action !== 'resolve' && action !== 'reopen') {
      return json(400, { error: 'action has to be resolve or reopen.' });
    }

    const patch = action === 'resolve'
      ? {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolution_note: body.note || null,
      }
      : { status: 'open', resolved_at: null, resolution_note: null };

    const res = await supabase
      .from('exceptions')
      .update(patch)
      .eq('exception_id', id)
      .eq('store_id', store_id)
      .select('exception_id, code, status');
    if (res.error) return json(500, { error: res.error.message });
    const row = (res.data || [])[0];
    if (!row) return json(404, { error: 'No such item.' });

    return json(200, {
      ok: true,
      exception: row,
      message: action === 'resolve' ? 'Marked as dealt with.' : 'Put back on the list.',
    });
  }

  // ---------------- what is open ---------------------------------------
  let query = supabase
    .from('exceptions')
    .select('exception_id, severity, code, message, suggested_action, status, '
      + 'raised_at, entity_type, entity_id')
    .eq('store_id', store_id)
    .order('raised_at', { ascending: false })
    .limit(300);

  if (!q.all) query = query.eq('status', 'open');

  const res = await query;
  if (res.error) return json(500, { error: res.error.message });

  const rows = (res.data || []).map((r) => ({
    exception_id: r.exception_id,
    severity: r.severity,
    code: r.code,
    headline: HEADLINE[r.code] || null,
    message: r.message,
    suggested_action: r.suggested_action,
    status: r.status,
    raised_at: r.raised_at,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
  })).sort((a, b) => {
    const ra = RANK[a.severity] === undefined ? 3 : RANK[a.severity];
    const rb = RANK[b.severity] === undefined ? 3 : RANK[b.severity];
    if (ra !== rb) return ra - rb;
    return String(b.raised_at).localeCompare(String(a.raised_at));
  });

  const counts = { critical: 0, warn: 0, info: 0 };
  rows.forEach((r) => {
    if (counts[r.severity] !== undefined) counts[r.severity] += 1;
  });

  // Repeats of the same thing are collapsed for the phone, where a list
  // of four hundred identical lines is the same as no list at all.
  const grouped = {};
  rows.forEach((r) => {
    const g = grouped[r.code] || (grouped[r.code] = {
      code: r.code,
      headline: r.headline || r.code,
      severity: r.severity,
      count: 0,
      newest: r.raised_at,
      example: r.message,
      example_id: r.exception_id,
    });
    g.count += 1;
    if (RANK[r.severity] < RANK[g.severity]) g.severity = r.severity;
    if (String(r.raised_at) > String(g.newest)) {
      g.newest = r.raised_at;
      g.example = r.message;
      g.example_id = r.exception_id;
    }
  });

  const groups = Object.keys(grouped).map((k) => grouped[k]).sort((a, b) => {
    const ra = RANK[a.severity] === undefined ? 3 : RANK[a.severity];
    const rb = RANK[b.severity] === undefined ? 3 : RANK[b.severity];
    if (ra !== rb) return ra - rb;
    return b.count - a.count;
  });

  return json(200, {
    ok: true,
    open: rows.length,
    counts: counts,
    // What the phone shows: one line per kind of problem.
    groups: groups,
    // What the desktop shows: every one of them.
    items: rows,
  });
});

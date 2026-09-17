// functions/probe.js
// READ ONLY. Lists every table in Supabase, row counts, columns, and the newest
// rows in anything sales-shaped. Nothing is written or changed.
//
// Modern async handler — required on Netlify's Node 24 runtime.
// Callback-style handlers (event, context, callback) are REMOVED and crash on call.
//
// Gated: set PROBE_KEY in Netlify env vars, call with ?key=<that value>.
// Open: https://famous-caramel-1cf571.netlify.app/.netlify/functions/probe?key=YOURKEY

const BUDGET_MS = 9000;

export default async (request, context) => {
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);

  const out = {
    checked_at: new Date().toISOString(),
    runtime: `node ${process.version}`,
    handler_style: 'async (works on Node 24)',
    supabase_host: null,
    supabase_project_ref: null,
    service_key_tail: null,
    tables: [],
    sales_samples: {},
    notes: []
  };

  const reply = (status = 200) =>
    new Response(JSON.stringify(out, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

  // --- auth gate -----------------------------------------------------------
  const probeKey = process.env.PROBE_KEY;
  const supplied = new URL(request.url).searchParams.get('key') || '';
  if (!probeKey) {
    out.notes.push('PROBE_KEY is not set in Netlify environment variables.');
    return reply(403);
  }
  if (supplied !== probeKey) {
    out.notes.push('Wrong or missing key. Call with ?key=<your PROBE_KEY>.');
    return reply(403);
  }

  // --- env -----------------------------------------------------------------
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    out.notes.push('SUPABASE_URL or SUPABASE_SERVICE_KEY missing from this deploy context.');
    return reply(500);
  }
  const host = base.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  out.supabase_host = host;
  out.supabase_project_ref = host.split('.')[0];
  out.service_key_tail = '...' + key.slice(-6);

  const root = base.replace(/\/+$/, '');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };

  const get = async (path, extra = {}) => {
    const res = await fetch(root + path, {
      headers: { ...headers, ...extra },
      signal: AbortSignal.timeout(Math.max(1500, left()))
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok) {
      throw new Error(`http ${res.status}${body?.message ? ': ' + body.message : ''}`);
    }
    return { body, headers: res.headers };
  };

  // --- 1. table list from the PostgREST OpenAPI root ------------------------
  let spec;
  try {
    spec = (await get('/rest/v1/')).body;
  } catch (e) {
    out.notes.push('Could not read the table list: ' + e.message);
    return reply(200);
  }
  if (!spec?.definitions) {
    out.notes.push('No table definitions returned — the service key may lack access.');
    return reply(200);
  }

  const names = Object.keys(spec.definitions).sort();
  out.notes.push(`${names.length} tables visible to the service key.`);

  // --- 2. row count + columns per table ------------------------------------
  for (const t of names) {
    if (left() < 1500) {
      out.notes.push(`Stopped early at ${out.tables.length} of ${names.length} tables (time limit).`);
      break;
    }
    const columns = Object.keys(spec.definitions[t]?.properties || {});
    try {
      const { headers: h } = await get(
        `/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`,
        { Prefer: 'count=exact', Range: '0-0' }
      );
      const cr = h.get('content-range') || '';
      const tail = cr.split('/')[1];
      const rows = tail && tail !== '*' ? parseInt(tail, 10) : null;
      out.tables.push({ table: t, rows, columns, empty: rows === 0 });
    } catch (e) {
      out.tables.push({ table: t, rows: null, columns, error: e.message });
    }
  }

  // --- 3. newest rows from anything sales-shaped ----------------------------
  const salesish = names.filter(n =>
    /sale|dept|tender|transaction|invoice|check|cash|eod|daily/i.test(n));

  for (const t of salesish) {
    if (left() < 1500) break;
    const props = spec.definitions[t]?.properties || {};
    const orderCol = ['business_date', 'sale_date', 'date', 'created_at', 'updated_at', 'timestamp']
      .find(c => props[c]) || '';
    try {
      const { body } = await get(
        `/rest/v1/${encodeURIComponent(t)}?select=*&limit=3` +
        (orderCol ? `&order=${orderCol}.desc` : '')
      );
      out.sales_samples[t] = { ordered_by: orderCol || 'none', newest_rows: body };
    } catch (e) {
      out.sales_samples[t] = { error: e.message };
    }
  }

  // --- 4. summary ----------------------------------------------------------
  const withRows = out.tables.filter(t => t.rows > 0).map(t => `${t.table} (${t.rows})`);
  const empty = out.tables.filter(t => t.rows === 0).map(t => t.table);
  out.summary = { tables_holding_data: withRows, tables_empty: empty };
  out.notes.push('Tables with data: ' +
    (withRows.length ? withRows.join(', ') : 'NONE — nothing is landing in Supabase at all.'));

  return reply(200);
};

export const config = { path: '/.netlify/functions/probe' };

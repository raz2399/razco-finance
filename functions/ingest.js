// Netlify Function: ingest
// Takes a day of Encore POS data from the store PC and writes it to the
// tables the dashboard actually reads.
//
// Route: /.netlify/functions/ingest
//   POST { token, store_id, days: [ { business_date, tenders: [...],
//                                     departments: [...], totals: {...} } ] }
//
// Why this exists rather than the store PC writing to Supabase directly:
// no database credentials ever sit on a machine in the store.
//
// Writes are replace-by-date. Every day in the payload has its existing rows
// deleted before the new ones go in, so re-running a day can never double a
// number — which matters because the historical rows are per-cashier and a
// blind upsert against a key containing a nullable employee_id would insert
// duplicates rather than replace.

const { createClient } = require('@supabase/supabase-js');
const { requireUser } = require('./lib/guard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const num = (v) => {
  const n = Number(v);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
};
const int = (v) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
};
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

exports.handler = async (event) => {
  // The store PC posts here on a schedule at six in the morning with
  // nobody sitting at it, so this one accepts its token as well as a
  // signed-in person.
  const auth = await requireUser(event, supabase, { allowSyncToken: true });
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Body is not JSON.' }); }

  const expected = process.env.SYNC_TOKEN;
  if (!expected) return json(500, { error: 'SYNC_TOKEN is not configured on the site.' });
  if (body.token !== expected) return json(401, { error: 'Bad token.' });

  const store_id = body.store_id || 'store1';
  const days = Array.isArray(body.days) ? body.days : [];
  if (!days.length) return json(400, { error: 'No days in the payload.' });

  const now = new Date().toISOString();
  const report = [];

  try {
    for (const day of days) {
      const date = day.business_date;
      if (!isDate(date)) {
        report.push({ business_date: date, skipped: 'not a YYYY-MM-DD date' });
        continue;
      }

      // ---- tenders: cash, credit, debit, EBT, by cashier ----
      const tenders = Array.isArray(day.tenders) ? day.tenders : [];
      const tenderRows = tenders
        .filter((t) => t.tender_id !== undefined && t.tender_id !== null)
        .map((t) => ({
          store_id,
          business_date: date,
          // Part of the unique key, and a NULL there would defeat it.
          employee_id: String(t.employee_id === undefined || t.employee_id === null ? 'ALL' : t.employee_id),
          tender_id: String(t.tender_id),
          open_float_amount: num(t.open_float_amount),
          tender_amount: num(t.tender_amount),
          tender_qty: int(t.tender_qty),
          pickup_amount: num(t.pickup_amount),
          pickup_qty: int(t.pickup_qty),
          declared_amount: num(t.declared_amount),
          // Over/short is NOT declared minus counted. Encore reports a
          // DeclaredAmount against card and EBT tenders too, where nothing
          // is counted into a drawer at all, so that subtraction produces
          // a figure that looks like a cash discrepancy and is not one.
          // Until the field Encore really uses for over/short is confirmed,
          // nothing is stored here. A blank is honest; a wrong number about
          // a cashier being short is not.
          over_short_amount: t.over_short_amount !== undefined && t.over_short_amount !== null
            ? num(t.over_short_amount)
            : null,
          synced_at: now,
        }));

      const delT = await supabase.from('tender_daily')
        .delete().eq('store_id', store_id).eq('business_date', date);
      if (delT.error) throw new Error('clearing tenders for ' + date + ': ' + delT.error.message);

      if (tenderRows.length) {
        const insT = await supabase.from('tender_daily').insert(tenderRows);
        if (insT.error) throw new Error('writing tenders for ' + date + ': ' + insT.error.message);
      }

      // ---- departments ----
      const depts = Array.isArray(day.departments) ? day.departments : [];
      const deptRows = depts
        .filter((d) => d.department_id !== undefined && d.department_id !== null)
        .map((d) => ({
          store_id,
          business_date: date,
          department_id: String(d.department_id),
          net_sales_amount: num(d.net_sales_amount),
          net_sales_qty: int(d.net_sales_qty),
          return_sales_amount: num(d.return_sales_amount),
          discount_sales_amount: num(d.discount_sales_amount),
          synced_at: now,
        }));

      const delD = await supabase.from('dept_sales')
        .delete().eq('store_id', store_id).eq('business_date', date);
      if (delD.error) throw new Error('clearing departments for ' + date + ': ' + delD.error.message);

      if (deptRows.length) {
        const insD = await supabase.from('dept_sales').insert(deptRows);
        if (insD.error) throw new Error('writing departments for ' + date + ': ' + insD.error.message);
      }

      report.push({
        business_date: date,
        tenders: tenderRows.length,
        departments: deptRows.length,
        tender_total: Math.round(tenderRows.reduce((s, r) => s + r.tender_amount, 0) * 100) / 100,
        dept_total: Math.round(deptRows.reduce((s, r) => s + r.net_sales_amount, 0) * 100) / 100,
      });
    }

    // ---- watermark, so the dashboard can say how fresh it is ----
    const written = report.filter((r) => !r.skipped).map((r) => r.business_date).sort();
    if (written.length) {
      const up = await supabase.from('store_sync').upsert({
        store_id,
        store_name: body.store_name || 'Razco Foods',
        business_date: written[written.length - 1],
        synced_at: now,
        status: 'ok',
        error: null,
        store_totals: { days: report },
      }, { onConflict: 'store_id' });
      if (up.error) throw new Error('updating the sync watermark: ' + up.error.message);
    }

    return json(200, {
      ok: true,
      store_id,
      days_written: written.length,
      first_day: written[0] || null,
      last_day: written[written.length - 1] || null,
      detail: report,
    });
  } catch (err) {
    // Record the failure so a silent death is impossible.
    await supabase.from('store_sync').upsert({
      store_id,
      synced_at: now,
      status: 'error',
      error: err.message,
    }, { onConflict: 'store_id' }).then(() => {}, () => {});

    return json(500, { error: err.message, where: 'ingest', written: report });
  }
};

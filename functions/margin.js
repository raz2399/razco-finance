// Margin by department.
//
// Sales come from the POS feed, read only -- nothing here writes to
// dept_sales or touches the Encore sync in any way. Purchases come from
// invoices, through the vendor's department. The arithmetic and the
// honesty about what the figure is live in lib/margin.js.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { byDepartment, money } = require('./lib/margin');

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

exports.handler = safely('margin', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const store_id = q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  // Four weeks by default, because that is roughly where purchases stop
  // being a story about deliveries and start being a story about margin.
  const weeks = Math.min(Math.max(Number(q.weeks) || 4, 1), 26);
  const since = new Date(Date.now() - weeks * 7 * 86400000).toISOString().slice(0, 10);

  // Purchases cannot reach back before the cutover: those bills are
  // inside the QuickBooks opening balances, and counting them again
  // would show a department buying twice what it bought.
  //
  // Which means SALES must stop at the same date. Four weeks of sales
  // against nine days of buying is the worst kind of wrong number --
  // every department would show a seventy per cent margin and look like
  // the best month the store had ever had. Both halves share one window,
  // and the window is the later of the two starts.
  const settings = await supabase.from('store_settings')
    .select('cutover_date').eq('store_id', store_id).maybeSingle();
  const cutover = (settings.data && settings.data.cutover_date) || null;
  const from = cutover && cutover > since ? cutover : since;

  // And the honesty line has to describe the window he is actually
  // getting, not the one he asked for -- otherwise a nine-day figure
  // would be labelled four weeks and read as reliable.
  const actualDays = Math.max(
    1, Math.round((Date.now() - new Date(from + 'T12:00:00Z').getTime()) / 86400000));
  const actualWeeks = Math.round((actualDays / 7) * 10) / 10;

  const [sales, names, invoices, vendors, cats] = await Promise.all([
    readAll('dept_sales', 'department_id, net_sales_amount',
      (p) => p.eq('store_id', store_id).gte('business_date', from)),
    readAll('department_names', 'department_id, name', (p) => p.limit(500)),
    readAll('invoices', 'vendor_id, total_amount, invoice_date, status',
      (p) => p.eq('store_id', store_id).gte('invoice_date', from)),
    readAll('vendors', 'vendor_id, name, default_category_id',
      (p) => p.eq('store_id', store_id)),
    readAll('expense_categories', 'category_id, name, department_id, ledger_type',
      (p) => p.eq('store_id', store_id)),
  ]);

  const nameOf = {};
  names.forEach((n) => { nameOf[String(n.department_id)] = n.name; });

  const deptOfCat = {};
  cats.forEach((c) => {
    if (c.department_id) deptOfCat[c.category_id] = String(c.department_id);
  });

  const deptOfVendor = {};
  const vendorName = {};
  vendors.forEach((v) => {
    vendorName[v.vendor_id] = v.name;
    const d = deptOfCat[v.default_category_id];
    if (d) deptOfVendor[v.vendor_id] = d;
  });

  // Buying that has no department yet, kept visible rather than
  // dropped. An uncoded vendor is the reason a department's margin looks
  // too good, so the figure that explains it sits next to it.
  const uncoded = {};
  let uncodedTotal = 0;

  const purchases = [];
  invoices.forEach((i) => {
    if (i.status === 'void' || !i.vendor_id) return;
    const amount = Math.abs(money(i.total_amount));
    if (!(amount > 0)) return;
    const d = deptOfVendor[i.vendor_id];
    if (d) {
      purchases.push({ department_id: d, amount: amount });
    } else {
      const n = vendorName[i.vendor_id] || 'Unknown vendor';
      uncoded[n] = money((uncoded[n] || 0) + amount);
      uncodedTotal = money(uncodedTotal + amount);
    }
  });

  const out = byDepartment(sales, purchases, nameOf, actualWeeks, uncodedTotal);

  const waiting = Object.keys(uncoded)
    .map((n) => ({ vendor: n, amount: uncoded[n] }))
    .sort((a, b) => b.amount - a.amount);

  return json(200, Object.assign(out, {
    ok: true,
    since: from,
    asked_weeks: weeks,
    actual_days: actualDays,
    // Said out loud when the cutover, not his choice, decided the window.
    clipped_by_cutover: !!(cutover && cutover > since),
    uncoded_vendors: waiting.slice(0, 15),
    uncoded_count: waiting.length,
    says: (cutover && cutover > since
        ? 'Sales against purchases since your ' + cutover + ' cutover (' + actualDays
          + ' days) \u2014 there is no buying on file before that, so sales are '
          + 'held to the same window rather than compared against nothing. '
        : 'Sales against purchases over ' + actualWeeks + ' weeks. ')
      + 'Stock is not counted, so read this over a month rather than a week.'
      + (uncodedTotal > 0
        ? ' ' + waiting.length + ' vendor' + (waiting.length === 1 ? '' : 's')
          + ' have no department yet, so their buying is in none of these lines.'
        : ''),
  }));
});

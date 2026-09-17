// Netlify Function: profit-and-loss
// Weekly P&L built from the tables that actually hold data.
// Route: /.netlify/functions/profit-and-loss
// Method: GET
// Query params:
//   store_id   (required)
//   week_start (YYYY-MM-DD, optional)
//   days       (window length, default 7)
//   cogs       (cost of goods %, default 75)
//
// REWRITTEN:
//  - sales now come from dept_sales (1,100+ real rows) instead of daily_sales,
//    which nothing has ever written to
//  - tender mix comes from tender_daily
//  - the window anchors to the LATEST business_date on file, so a gap in the
//    store sync shows as a stale-data warning instead of an empty screen
//  - customer_count is not in the POS feed, so it is reported as null rather
//    than invented

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
};
const todayStr = () => new Date().toISOString().split('T')[0];

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const store_id = q.store_id;
    const days = Math.max(1, Math.min(90, parseInt(q.days || '7', 10)));
    const cogsPct = Math.max(0, Math.min(100, parseFloat(q.cogs || '75')));

    if (!store_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing store_id' }) };
    }

    const status = {};
    const warnings = [];

    // --- work out the window ------------------------------------------------
    let weekEndStr;
    let latestOnFile = null;

    const latest = await supabase
      .from('dept_sales')
      .select('business_date')
      .eq('store_id', store_id)
      .order('business_date', { ascending: false })
      .limit(1);

    if (latest.data && latest.data[0]) latestOnFile = latest.data[0].business_date;

    if (q.week_start) {
      weekEndStr = addDays(q.week_start, days - 1);
    } else if (latestOnFile) {
      weekEndStr = latestOnFile;                       // anchor to real data
    } else {
      weekEndStr = todayStr();
    }
    const weekStartStr = q.week_start || addDays(weekEndStr, -(days - 1));

    if (latestOnFile) {
      const lag = Math.round(
        (new Date(todayStr()) - new Date(latestOnFile)) / 86400000
      );
      status.dept_sales = `ok (latest ${latestOnFile})`;
      if (lag > 1) {
        warnings.push({
          severity: lag > 3 ? 'critical' : 'warn',
          message: `Sales data is ${lag} days behind. Latest day on file is ${latestOnFile} — the store sync may have stopped.`,
        });
      }
    } else {
      status.dept_sales = 'no rows for this store';
      warnings.push({ severity: 'critical', message: 'No sales data at all for this store.' });
    }

    // --- sales by day and department ---------------------------------------
    const sales = await supabase
      .from('dept_sales')
      .select('business_date, department_id, net_sales_amount, net_sales_qty, return_sales_amount, discount_sales_amount')
      .eq('store_id', store_id)
      .gte('business_date', weekStartStr)
      .lte('business_date', weekEndStr);

    if (sales.error) throw sales.error;

    const byDay = {};
    const byDept = {};
    let totalSales = 0;
    let totalUnits = 0;
    let totalReturns = 0;
    let totalDiscounts = 0;

    (sales.data || []).forEach((r) => {
      const amt = Number(r.net_sales_amount) || 0;
      const qty = Number(r.net_sales_qty) || 0;
      const ret = Math.abs(Number(r.return_sales_amount) || 0);
      const dis = Math.abs(Number(r.discount_sales_amount) || 0);

      totalSales += amt;
      totalUnits += qty;
      totalReturns += ret;
      totalDiscounts += dis;

      if (!byDay[r.business_date]) {
        byDay[r.business_date] = { date: r.business_date, sales: 0, units: 0, returns: 0, discounts: 0 };
      }
      byDay[r.business_date].sales += amt;
      byDay[r.business_date].units += qty;
      byDay[r.business_date].returns += ret;
      byDay[r.business_date].discounts += dis;

      const d = String(r.department_id);
      if (!byDept[d]) byDept[d] = { department_id: d, sales: 0, units: 0 };
      byDept[d].sales += amt;
      byDept[d].units += qty;
    });

    const dailyDetail = Object.keys(byDay).sort().map((k) => ({
      date: byDay[k].date,
      sales: round(byDay[k].sales),
      units: byDay[k].units,
      returns: round(byDay[k].returns),
      discounts: round(byDay[k].discounts),
      customers: null,
      avg_transaction: null,
    }));

    const departments = Object.keys(byDept)
      .map((k) => ({
        department_id: byDept[k].department_id,
        sales: round(byDept[k].sales),
        units: byDept[k].units,
        percent_of_sales: totalSales > 0 ? round((byDept[k].sales / totalSales) * 100) : 0,
      }))
      .sort((a, b) => b.sales - a.sales);

    // --- how customers paid -------------------------------------------------
    const tender = await supabase
      .from('tender_daily')
      .select('business_date, tender_id, tender_amount, over_short_amount')
      .eq('store_id', store_id)
      .gte('business_date', weekStartStr)
      .lte('business_date', weekEndStr);

    const tenderMix = {};
    let overShort = 0;
    (tender.data || []).forEach((r) => {
      const id = String(r.tender_id);
      if (!tenderMix[id]) tenderMix[id] = { tender_id: id, amount: 0 };
      tenderMix[id].amount += Number(r.tender_amount) || 0;
      overShort += Number(r.over_short_amount) || 0;
    });
    const tenderTotal = Object.keys(tenderMix).reduce((s, k) => s + tenderMix[k].amount, 0);
    status.tender_daily = tender.error
      ? 'error: ' + tender.error.message
      : `ok (${(tender.data || []).length} rows)`;

    // --- expenses and payables ---------------------------------------------
    const expenses = await supabase
      .from('invoices')
      .select('total_amount')
      .eq('store_id', store_id)
      .eq('status', 'paid')
      .gte('approved_at', weekStartStr + 'T00:00:00Z')
      .lte('approved_at', weekEndStr + 'T23:59:59Z');

    const totalExpenses = (expenses.data || []).reduce((s, i) => s + (Number(i.total_amount) || 0), 0);
    status.invoices = expenses.error
      ? 'error: ' + expenses.error.message
      : (expenses.data || []).length
        ? `ok (${expenses.data.length} paid this period)`
        : 'no invoices recorded yet';

    const openAP = await supabase
      .from('invoices')
      .select('balance_due')
      .eq('store_id', store_id)
      .in('status', ['approved', 'scheduled', 'partially_paid']);

    const totalOpenAP = (openAP.data || []).reduce((s, i) => s + (Number(i.balance_due) || 0), 0);

    const checks = await supabase
      .from('payments')
      .select('amount')
      .eq('store_id', store_id)
      .eq('method', 'check')
      .eq('status', 'outstanding');

    const outstandingChecks = (checks.data || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
    status.payments = checks.error
      ? 'error: ' + checks.error.message
      : (checks.data || []).length
        ? `ok (${checks.data.length} outstanding)`
        : 'no checks logged yet';

    if (!(expenses.data || []).length && !totalOpenAP) {
      warnings.push({
        severity: 'warn',
        message: 'No invoices on file, so expenses and profit are sales-only. Gross margin is reliable; operating profit is not.',
      });
    }

    // --- the numbers --------------------------------------------------------
    const estimatedCOGS = totalSales * (cogsPct / 100);
    const grossMargin = totalSales - estimatedCOGS;
    const operatingProfit = grossMargin - totalExpenses;
    const trueCashImpact = totalSales - outstandingChecks - totalOpenAP;
    const dayCount = dailyDetail.length;

    return {
      statusCode: 200,
      body: JSON.stringify({
        store_id,
        week_start: weekStartStr,
        week_end: weekEndStr,
        days_with_sales: dayCount,
        latest_sales_date: latestOnFile,
        summary: {
          total_sales: round(totalSales),
          estimated_cogs: round(estimatedCOGS),
          cogs_percent_used: cogsPct,
          gross_margin: round(grossMargin),
          gross_margin_percent: totalSales > 0 ? round((grossMargin / totalSales) * 100) : 0,
          operating_expenses: round(totalExpenses),
          operating_profit: round(operatingProfit),
          operating_profit_percent: totalSales > 0 ? round((operatingProfit / totalSales) * 100) : 0,
          total_units: totalUnits,
          total_returns: round(totalReturns),
          total_discounts: round(totalDiscounts),
          avg_daily_sales: dayCount > 0 ? round(totalSales / dayCount) : 0,
          total_customers: null,
          avg_sale_per_transaction: null,
        },
        cash_position: {
          sales_earned: round(totalSales),
          outstanding_checks: round(outstandingChecks),
          open_ap: round(totalOpenAP),
          true_cash_impact: round(trueCashImpact),
        },
        tender_mix: Object.keys(tenderMix)
          .map((k) => ({
            tender_id: k,
            amount: round(tenderMix[k].amount),
            percent: tenderTotal > 0 ? round((tenderMix[k].amount / tenderTotal) * 100) : 0,
          }))
          .sort((a, b) => b.amount - a.amount),
        tender_total: round(tenderTotal),
        over_short: round(overShort),
        departments: departments.slice(0, 25),
        daily_detail: dailyDetail,
        data_status: status,
        warnings,
        notes: [
          'Sales come from the POS department feed (dept_sales).',
          `COGS is an estimate at ${cogsPct}% — pass ?cogs=NN to change it.`,
          'Customer counts are not in the POS feed, so per-transaction averages are unavailable.',
        ],
      }),
    };
  } catch (error) {
    console.error('P&L calculation error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

// Netlify Function: profit-and-loss
// Calculates weekly P&L: sales - expenses - cash outflows = profit
// Route: /.netlify/functions/profit-and-loss
// Method: GET
// Query params: store_id, week_start (YYYY-MM-DD, optional)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  try {
    const { store_id, week_start } = event.queryStringParameters || {};

    if (!store_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing store_id' }),
      };
    }

    // Default to current week (Monday to today)
    const today = new Date();
    let weekStartDate = new Date(today);
    weekStartDate.setDate(weekStartDate.getDate() - weekStartDate.getDay() + 1); // Monday
    const weekStartStr = week_start || weekStartDate.toISOString().split('T')[0];
    const weekEndStr = today.toISOString().split('T')[0];

    // Get daily sales for the week
    const sales = await supabase
      .from('daily_sales')
      .select('business_date, net_sales, customer_count')
      .eq('store_id', store_id)
      .gte('business_date', weekStartStr)
      .lte('business_date', weekEndStr)
      .order('business_date', { ascending: true });

    if (sales.error) throw sales.error;

    const totalSales = sales.data
      ? sales.data.reduce((sum, day) => sum + (day.net_sales || 0), 0)
      : 0;

    const totalCustomers = sales.data
      ? sales.data.reduce((sum, day) => sum + (day.customer_count || 0), 0)
      : 0;

    // Get expenses (invoices paid this week)
    const expenses = await supabase
      .from('invoices')
      .select('total_amount, category_id, expense_categories(name)')
      .eq('store_id', store_id)
      .eq('status', 'paid')
      .gte('approved_at', weekStartStr + 'T00:00:00Z')
      .lte('approved_at', weekEndStr + 'T23:59:59Z');

    if (expenses.error) throw expenses.error;

    const totalExpenses = expenses.data
      ? expenses.data.reduce((sum, inv) => sum + (inv.total_amount || 0), 0)
      : 0;

    // Get outstanding checks (cash outflow, not yet cleared)
    const checks = await supabase
      .from('payments')
      .select('amount')
      .eq('store_id', store_id)
      .eq('method', 'check')
      .eq('status', 'outstanding');

    if (checks.error) throw checks.error;

    const outstandingChecks = checks.data
      ? checks.data.reduce((sum, c) => sum + (c.amount || 0), 0)
      : 0;

    // Get open AP (invoices not yet paid)
    const openAP = await supabase
      .from('invoices')
      .select('balance_due')
      .eq('store_id', store_id)
      .in('status', ['approved', 'scheduled', 'partially_paid']);

    if (openAP.error) throw openAP.error;

    const totalOpenAP = openAP.data
      ? openAP.data.reduce((sum, inv) => sum + (inv.balance_due || 0), 0)
      : 0;

    // COGS estimation (simplified: assume 75% for grocery)
    const estimatedCOGS = totalSales * 0.75;

    // Gross margin
    const grossMargin = totalSales - estimatedCOGS;

    // Operating profit (sales - COGS - paid expenses)
    const operatingProfit = grossMargin - totalExpenses;

    // Available cash impact (sales - checks - open AP)
    const trueCashImpact = totalSales - outstandingChecks - totalOpenAP;

    // Daily breakdown
    const dailyDetail = sales.data.map((day) => ({
      date: day.business_date,
      sales: day.net_sales,
      customers: day.customer_count,
      avg_transaction: day.customer_count > 0 ? (day.net_sales / day.customer_count).toFixed(2) : 0,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        store_id,
        week_start: weekStartStr,
        week_end: weekEndStr,
        summary: {
          total_sales: totalSales,
          estimated_cogs: estimatedCOGS,
          gross_margin: grossMargin,
          gross_margin_percent: totalSales > 0 ? ((grossMargin / totalSales) * 100).toFixed(1) : 0,
          operating_expenses: totalExpenses,
          operating_profit: operatingProfit,
          operating_profit_percent: totalSales > 0 ? ((operatingProfit / totalSales) * 100).toFixed(1) : 0,
          total_customers: totalCustomers,
          avg_sale_per_transaction: totalCustomers > 0 ? (totalSales / totalCustomers).toFixed(2) : 0,
        },
        cash_position: {
          sales_earned: totalSales,
          outstanding_checks: outstandingChecks,
          open_ap: totalOpenAP,
          true_cash_impact: trueCashImpact,
        },
        daily_detail: dailyDetail,
      }),
    };
  } catch (error) {
    console.error('P&L calculation error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

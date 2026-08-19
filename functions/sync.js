// Netlify Function: sync
// Receives POS data from Python sync agent and pushes to Supabase
// Route: /.netlify/functions/sync
// Method: POST
// Body: { store_id, sync_data }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method not allowed' };
    }

    const data = JSON.parse(event.body);
    
    // Accept both formats: { store_id, sync_data } or { store_id, daily_sales, ... }
    const store_id = data.store_id;
    const sync_data = data.sync_data || data;

    if (!store_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing store_id' }),
      };
    }

    // Sync daily sales data
    const daily_sales = sync_data.daily_sales || data.daily_sales;
    if (daily_sales && Array.isArray(daily_sales)) {
      for (const sale of daily_sales) {
        const { business_date, net_sales, customer_count } = sale;

        // Upsert: update if exists, insert if not
        const { error } = await supabase
          .from('daily_sales')
          .upsert(
            {
              store_id,
              business_date,
              net_sales: parseFloat(net_sales) || 0,
              customer_count: parseInt(customer_count) || 0,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'store_id,business_date' }
          );

        if (error) throw error;
      }
    }

    // Sync tender totals (cash, credit, debit, etc.)
    const tender_totals = sync_data.tender_totals || data.tender_totals;
    if (tender_totals && Array.isArray(tender_totals)) {
      for (const tender of tender_totals) {
        const { business_date, tender_id, amount } = tender;

        const { error } = await supabase
          .from('tender_totals')
          .upsert(
            {
              store_id,
              business_date,
              tender_id: parseInt(tender_id),
              amount: parseFloat(amount) || 0,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'store_id,business_date,tender_id' }
          );

        if (error) throw error;
      }
    }

    // Sync department sales
    const dept_sales = sync_data.dept_sales || data.dept_sales;
    if (dept_sales && Array.isArray(dept_sales)) {
      for (const dept of dept_sales) {
        const { business_date, dept_id, net_sales } = dept;

        const { error } = await supabase
          .from('dept_sales')
          .upsert(
            {
              store_id,
              business_date,
              dept_id: parseInt(dept_id),
              net_sales: parseFloat(net_sales) || 0,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'store_id,business_date,dept_id' }
          );

        if (error) throw error;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Sync successful',
        store_id,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error('Sync error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

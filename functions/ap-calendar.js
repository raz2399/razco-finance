// Netlify Function: ap-calendar
// Calculates due dates, payment schedule, and aging report
// Route: /.netlify/functions/ap-calendar
// Method: GET
// Query params: store_id, start_date (YYYY-MM-DD), end_date (YYYY-MM-DD)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Calculate due date based on terms
function calculateDueDate(invoiceDate, termsCode, termsDays) {
  const invDate = new Date(invoiceDate);
  let dueDate = new Date(invDate);

  switch (termsCode) {
    case 'cod':
      dueDate = new Date(invDate); // Same day
      break;
    case 'net7':
    case 'net10':
    case 'net15':
    case 'net30':
      dueDate.setDate(invDate.getDate() + (termsDays || 30));
      break;
    case 'eom':
      // Last day of invoice month
      dueDate = new Date(invDate.getFullYear(), invDate.getMonth() + 1, 0);
      break;
    case 'prox10':
      // 10th of following month
      dueDate = new Date(invDate.getFullYear(), invDate.getMonth() + 1, 10);
      break;
    case 'weekly':
      // Next statement day
      dueDate.setDate(invDate.getDate() + 7);
      break;
    default:
      dueDate.setDate(invDate.getDate() + (termsDays || 30));
  }

  // Move to prior business day if lands on weekend
  const dow = dueDate.getDay();
  if (dow === 6) dueDate.setDate(dueDate.getDate() - 1); // Saturday → Friday
  if (dow === 0) dueDate.setDate(dueDate.getDate() - 2); // Sunday → Friday

  return dueDate.toISOString().split('T')[0];
}

// Age status
function getAgeStatus(dueDate, today) {
  const due = new Date(dueDate);
  const now = new Date(today);

  const diffMs = now - due;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 'upcoming';
  if (diffDays <= 0) return 'due_today';
  if (diffDays <= 5) return 'overdue_5';
  if (diffDays <= 30) return 'overdue_30';
  return 'overdue_60';
}

exports.handler = async (event) => {
  try {
    const { store_id, start_date, end_date } = event.queryStringParameters || {};

    if (!store_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing store_id' }),
      };
    }

    const today = new Date().toISOString().split('T')[0];
    const searchStart = start_date || new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().split('T')[0];
    const searchEnd = end_date || new Date(new Date().setDate(new Date().getDate() + 60)).toISOString().split('T')[0];

    // Fetch open invoices
    const invoices = await supabase
      .from('invoices')
      .select(`
        invoice_id,
        invoice_number,
        vendor_id,
        vendors(name, code, payment_type, terms_code, terms_days),
        invoice_date,
        total_amount,
        amount_paid,
        balance_due,
        status
      `)
      .eq('store_id', store_id)
      .in('status', ['approved', 'scheduled', 'partially_paid'])
      .gte('invoice_date', searchStart)
      .lte('invoice_date', searchEnd)
      .order('invoice_date', { ascending: false });

    if (invoices.error) throw invoices.error;

    // Calculate due dates and payment schedule
    const calendar = invoices.data.map((inv) => {
      const vendor = inv.vendors;
      const dueDate = calculateDueDate(
        inv.invoice_date,
        vendor.terms_code,
        vendor.terms_days
      );
      const status = getAgeStatus(dueDate, today);

      return {
        invoice_id: inv.invoice_id,
        invoice_number: inv.invoice_number,
        vendor_name: vendor.name,
        vendor_code: vendor.code,
        payment_type: vendor.payment_type,
        invoice_date: inv.invoice_date,
        due_date: dueDate,
        days_until_due: Math.floor((new Date(dueDate) - new Date(today)) / (1000 * 60 * 60 * 24)),
        amount: inv.total_amount,
        paid: inv.amount_paid,
        balance: inv.balance_due,
        age_status: status,
        is_overdue: status.startsWith('overdue'),
      };
    });

    // Group by due date for payment runs
    const byDueDate = {};
    calendar.forEach((item) => {
      const due = item.due_date;
      if (!byDueDate[due]) {
        byDueDate[due] = [];
      }
      byDueDate[due].push(item);
    });

    // Summary
    const totalOpen = calendar.reduce((sum, inv) => sum + inv.balance, 0);
    const totalOverdue = calendar
      .filter((inv) => inv.is_overdue)
      .reduce((sum, inv) => sum + inv.balance, 0);

    const upcomingWeek = calendar
      .filter((inv) => inv.days_until_due >= 0 && inv.days_until_due <= 7)
      .reduce((sum, inv) => sum + inv.balance, 0);

    return {
      statusCode: 200,
      body: JSON.stringify({
        store_id,
        as_of_date: today,
        summary: {
          total_open_ap: totalOpen,
          total_overdue: totalOverdue,
          due_this_week: upcomingWeek,
          invoice_count: calendar.length,
          overdue_count: calendar.filter((inv) => inv.is_overdue).length,
        },
        calendar: calendar.sort((a, b) => new Date(a.due_date) - new Date(b.due_date)),
        by_due_date: byDueDate,
      }),
    };
  } catch (error) {
    console.error('AP calendar error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// Netlify Function: ap-calendar
// Calculates due dates, payment schedule, and aging report
// Route: /.netlify/functions/ap-calendar
// Method: GET
// Query params: store_id, start_date (YYYY-MM-DD), end_date (YYYY-MM-DD)

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');

// A refusal, in the shape every endpoint here already answers in.
//
// The auth guard was added to all of these at once with `return json(...)`,
// and eight of them had no json helper -- they build their replies inline.
// So the moment the guard needed to say no, the function threw
// "json is not defined" instead of answering 401, and the screen showed
// that sentence to Raz. A refusal that crashes is not a refusal.
const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  },
  body: JSON.stringify(body),
});

// The store is in Lindsay, California. Its day ends when the store closes,
// not at 5pm local when UTC rolls into tomorrow -- which is exactly when the
// back office is being worked. Business dates are Pacific; instants
// (created_at and friends) stay UTC, because those are moments, not days.
const BUSINESS_TZ = 'America/Los_Angeles';
const pacificToday = () => new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// When a bill is actually due.
//
// Returns null when nobody knows. That is the whole point of this
// function now, and it used to do the opposite: with no terms on file
// it fell through to `termsDays || 30` and produced a confident date
// thirty days out. 251 of Razco's 255 vendors have no terms on file, so
// almost every due date on the screen was that invented number -- and
// it drove "due this week", which is the figure Raz pays bills from.
//
// An invented due date is worse than a missing one in both directions:
// a COD vendor looks like it can wait a month, and a bill with real
// terms of net 7 sits quietly until it is three weeks late. A blank is
// visible. A plausible wrong answer is not.
function calculateDueDate(invoiceDate, termsCode, termsDays) {
  // Nothing to go on. Say so.
  if (!termsCode && (termsDays === null || termsDays === undefined)) return null;

  // Everything below is done in UTC, deliberately and consistently.
  //
  // A due date is a date on a calendar, not a moment. "2026-10-01" parses
  // as UTC midnight, but getDate() and getDay() read in the server's
  // local zone -- so the same invoice could come out a day apart, and
  // land on a different side of a weekend, depending on where the code
  // happened to run. It read Friday here and Saturday on Netlify.
  // Mixing the two is the bug; picking one and holding to it is the fix.
  const invDate = new Date(invoiceDate + 'T00:00:00Z');
  if (isNaN(invDate.getTime())) return null;
  const dueDate = new Date(invDate.getTime());

  switch (termsCode) {
    case 'cod':
      // Same day. Nothing to add.
      break;
    case 'net7':
    case 'net10':
    case 'net15':
    case 'net30':
      dueDate.setUTCDate(invDate.getUTCDate() + (termsDays || 30));
      break;
    case 'eom':
      // Last day of invoice month
      dueDate.setUTCFullYear(invDate.getUTCFullYear(), invDate.getUTCMonth() + 1, 0);
      break;
    case 'prox10':
      // 10th of following month
      dueDate.setUTCFullYear(invDate.getUTCFullYear(), invDate.getUTCMonth() + 1, 10);
      break;
    case 'weekly':
      // Next statement day
      dueDate.setUTCDate(invDate.getUTCDate() + 7);
      break;
    default:
      // A terms code nobody recognises, with a day count beside it.
      // The day count is real; use it. Without one there is nothing to
      // compute from, and 30 would be a guess wearing a number.
      if (termsDays === null || termsDays === undefined) return null;
      dueDate.setUTCDate(invDate.getUTCDate() + termsDays);
  }

  // Move to prior business day if lands on weekend
  const dow = dueDate.getUTCDay();
  if (dow === 6) dueDate.setUTCDate(dueDate.getUTCDate() - 1); // Saturday → Friday
  if (dow === 0) dueDate.setUTCDate(dueDate.getUTCDate() - 2); // Sunday → Friday

  return dueDate.toISOString().split('T')[0];
}

// Age status
function getAgeStatus(dueDate, today) {
  // No due date, no age. Calling an unknown bill "upcoming" would file
  // it under things that are fine, which is the one place it must not go.
  if (!dueDate) return 'terms_unknown';

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

exports.handler = safely('ap-calendar', async (event) => {
  // Nobody sees any of this without signing in. Before this, the URL was
  // the only thing between a stranger and the bank position, and a URL is
  // not a secret: it is in browser history, in a chat message, on a screen
  // in a stockroom.
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  try {
    const { store_id, start_date, end_date } = event.queryStringParameters || {};

    if (!store_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing store_id' }),
      };
    }

    const today = pacificToday();
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
        due_date,
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

      // The date printed on the bill beats anything computed from terms.
      // It used to be ignored entirely: an invoice that said "due 11
      // November" in the vendor's own hand was overwritten by a date
      // worked out from a terms table. The paper is the agreement.
      const fromTerms = calculateDueDate(
        inv.invoice_date,
        vendor.terms_code,
        vendor.terms_days
      );
      const dueDate = inv.due_date || fromTerms;
      const source = inv.due_date ? 'on the invoice'
        : (fromTerms ? 'from ' + (vendor.terms_code || vendor.terms_days + ' days')
                     : null);

      const status = getAgeStatus(dueDate, today);

      return {
        invoice_id: inv.invoice_id,
        invoice_number: inv.invoice_number,
        vendor_id: inv.vendor_id,
        vendor_name: vendor.name,
        vendor_code: vendor.code,
        payment_type: vendor.payment_type,
        invoice_date: inv.invoice_date,
        due_date: dueDate,
        due_date_source: source,
        days_until_due: dueDate
          ? Math.floor((new Date(dueDate) - new Date(today)) / (1000 * 60 * 60 * 24))
          : null,
        amount: inv.total_amount,
        paid: inv.amount_paid,
        balance: inv.balance_due,
        age_status: status,
        is_overdue: status.indexOf('overdue') === 0,
      };
    });

    // Bills with no known due date are kept out of the dated buckets
    // entirely, and counted on their own. Putting them under today's
    // date, or under "no date", would quietly seed the payment run with
    // bills nobody has decided about.
    const dated = calendar.filter((i) => i.due_date);
    const undated = calendar.filter((i) => !i.due_date);

    const byDueDate = {};
    dated.forEach((item) => {
      const due = item.due_date;
      if (!byDueDate[due]) byDueDate[due] = [];
      byDueDate[due].push(item);
    });

    // Summary
    const totalOpen = calendar.reduce((sum, inv) => sum + inv.balance, 0);
    const totalOverdue = calendar
      .filter((inv) => inv.is_overdue)
      .reduce((sum, inv) => sum + inv.balance, 0);

    const upcomingWeek = dated
      .filter((inv) => inv.days_until_due >= 0 && inv.days_until_due <= 7)
      .reduce((sum, inv) => sum + inv.balance, 0);

    const undatedTotal = undated.reduce((sum, inv) => sum + inv.balance, 0);

    // Which vendors are causing the blanks, biggest money first. Setting
    // terms on the top few is what turns most of this list into dates.
    const blameByVendor = {};
    undated.forEach((i) => {
      const k = i.vendor_name || 'unnamed';
      const b = blameByVendor[k] || (blameByVendor[k] = {
        vendor_id: i.vendor_id, vendor_name: k, bills: 0, balance: 0,
      });
      b.bills += 1;
      b.balance = Math.round((b.balance + Number(i.balance || 0)) * 100) / 100;
    });
    const needTerms = Object.keys(blameByVendor)
      .map((k) => blameByVendor[k])
      .sort((a, b) => b.balance - a.balance);

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
          // Said plainly rather than folded into the other figures: this
          // much money is on bills whose due date nobody knows.
          no_due_date_count: undated.length,
          no_due_date_total: Math.round(undatedTotal * 100) / 100,
        },
        calendar: dated
          .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
          .concat(undated),
        by_due_date: byDueDate,
        no_due_date: undated,
        vendors_needing_terms: needTerms,
      }),
    };
  } catch (error) {
    console.error('AP calendar error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
});

// Netlify Function: daily-brief (scheduled)
// Runs every morning and says what happened and what needs him today.
//
// Route: /.netlify/functions/daily-brief
//   Scheduled by netlify.toml. Also callable by hand:
//     GET ?store_id=store1          -> the brief as JSON, sends nothing
//     GET ?store_id=store1&send=1   -> builds it and sends it
//
// It reads the same numbers the dashboard shows. One source, so the brief
// can never disagree with the screen.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dollars = (n) => (n < 0 ? '-$' : '$') +
  Math.abs(money(n)).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const iso = (d) => d.toISOString().split('T')[0];
const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// Pacific, without pulling in a timezone library: the store is in Lindsay,
// CA, and the brief only needs the local calendar date.
function pacificToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

async function build(store_id) {
  const today = pacificToday();
  const yesterday = iso(addDays(new Date(today + 'T00:00:00Z'), -1));
  const inThree = iso(addDays(new Date(today + 'T00:00:00Z'), 3));

  const [tenderTypesRes, yRes, invRes, vendRes, payRes, acctRes, syncRes] = await Promise.all([
    supabase.from('tender_types').select('tender_id, bucket'),
    supabase.from('tender_daily').select('business_date, tender_id, tender_amount')
      .eq('store_id', store_id).eq('business_date', yesterday),
    supabase.from('invoices')
      .select('invoice_id, vendor_id, total_amount, balance_due, due_date, status, payment_type, received_date')
      .eq('store_id', store_id),
    supabase.from('vendors').select('vendor_id, name').eq('store_id', store_id),
    supabase.from('payments')
      .select('payment_id, method, amount, check_number, vendor_id, status, cleared_date, payment_date')
      .eq('store_id', store_id),
    supabase.from('bank_accounts').select('nickname, last_four, current_balance, balance_as_of')
      .eq('store_id', store_id).eq('active', true),
    supabase.from('store_sync').select('business_date, synced_at').eq('store_id', store_id).limit(1),
  ]);

  const bucketOf = {};
  (tenderTypesRes.data || []).forEach((t) => { bucketOf[String(t.tender_id)] = t.bucket || 'other'; });

  let cash = 0, card = 0, chk = 0;
  (yRes.data || []).forEach((r) => {
    const b = bucketOf[String(r.tender_id)] || 'other';
    const amt = money(r.tender_amount);
    if (b === 'cash') cash += amt;
    else if (b === 'check') chk += amt;
    else if (b === 'other') { /* coupons are not money in */ }
    else card += amt;
  });
  const yesterdaySales = money(cash + card + chk);

  const vendorName = {};
  (vendRes.data || []).forEach((v) => { vendorName[v.vendor_id] = v.name; });

  const invoices = invRes.data || [];
  const open = invoices.filter((i) => i.status !== 'paid' && i.status !== 'void' && money(i.balance_due) > 0);
  const automatic = (i) => i.payment_type === 'cod_draft' || i.payment_type === 'auto_debit';

  const draftingToday = open.filter((i) => automatic(i) && i.due_date === today);
  const draftingSoon = open.filter((i) => automatic(i) && i.due_date > today && i.due_date <= inThree);
  const checksDue = open.filter((i) => !automatic(i) && i.due_date && i.due_date <= inThree);
  const pastDue = open.filter((i) => !automatic(i) && i.due_date && i.due_date < today);

  const payments = payRes.data || [];
  const outstanding = payments.filter(
    (p) => p.method === 'check' && !p.cleared_date && p.status !== 'void' && p.status !== 'cleared'
  );
  const clearedYesterday = payments.filter((p) => p.cleared_date === yesterday);

  const acct = (acctRes.data || [])[0] || null;
  const inBank = acct ? money(acct.current_balance) : 0;
  const checksOut = money(outstanding.reduce((s, p) => s + money(p.amount), 0));
  const apOpen = money(open.reduce((s, i) => s + money(i.balance_due), 0));
  const draftingTodayTotal = money(draftingToday.reduce((s, i) => s + money(i.balance_due), 0));

  const sync = (syncRes.data || [])[0] || null;
  const behind = sync && sync.business_date ? daysBetween(sync.business_date, today) : null;

  // ---- the message -------------------------------------------------------
  const L = [];
  L.push('Razi-Nova — ' + today);
  L.push('');

  if (yesterdaySales > 0) {
    L.push('Yesterday: ' + dollars(yesterdaySales) +
           '  (cash ' + dollars(cash) + ', card ' + dollars(card) + ')');
  } else if (behind !== null && behind > 1) {
    L.push('No sales yesterday. The register has not reported for ' + behind + ' days.');
  } else {
    L.push('No sales recorded for yesterday yet.');
  }

  L.push('In the bank: ' + dollars(inBank) + (acct && acct.balance_as_of ? ' as of ' + acct.balance_as_of : ''));
  L.push('After checks clear: ' + dollars(inBank - checksOut));
  L.push('After everything: ' + dollars(inBank - checksOut - apOpen));
  L.push('');

  const needs = [];

  if (draftingToday.length) {
    const short = draftingTodayTotal > inBank;
    needs.push((short ? '!! ' : '') + 'Drafting today: ' + dollars(draftingTodayTotal) + ' — ' +
      draftingToday.map((i) => (vendorName[i.vendor_id] || 'vendor') + ' ' + dollars(i.balance_due)).join(', ') +
      (short ? '  (more than is in the bank)' : ''));
  }
  pastDue.forEach((i) => {
    needs.push('!! Past due: ' + (vendorName[i.vendor_id] || 'vendor') + ' ' +
      dollars(i.balance_due) + ', was due ' + i.due_date);
  });
  checksDue.filter((i) => i.due_date >= today).forEach((i) => {
    needs.push('Check due ' + i.due_date + ': ' + (vendorName[i.vendor_id] || 'vendor') +
      ' ' + dollars(i.balance_due));
  });
  draftingSoon.forEach((i) => {
    needs.push('Drafts ' + i.due_date + ': ' + (vendorName[i.vendor_id] || 'vendor') +
      ' ' + dollars(i.balance_due));
  });
  if (inBank - checksOut < 0) {
    needs.push('!! The checks you have written come to more than is in the bank.');
  }
  if (behind !== null && behind > 1) {
    needs.push('Register sales are ' + behind + ' days behind. Last day in was ' + sync.business_date + '.');
  }

  if (needs.length) {
    L.push('Needs you:');
    needs.forEach((n) => L.push('  ' + n));
  } else {
    L.push('Nothing needs you today.');
  }

  if (clearedYesterday.length) {
    L.push('');
    L.push('Cleared yesterday: ' + clearedYesterday
      .map((p) => '#' + (p.check_number || '?') + ' ' + dollars(p.amount)).join(', '));
  }
  if (outstanding.length) {
    L.push('Still out: ' + outstanding.length + ' check' + (outstanding.length === 1 ? '' : 's') +
           ', ' + dollars(checksOut));
  }

  return {
    date: today,
    text: L.join('\n'),
    urgent: needs.filter((n) => n.indexOf('!!') === 0).length,
    numbers: {
      yesterday_sales: yesterdaySales, yesterday_cash: money(cash), yesterday_card: money(card),
      in_bank: inBank, checks_outstanding: checksOut, ap_open: apOpen,
      after_checks_clear: money(inBank - checksOut),
      after_everything: money(inBank - checksOut - apOpen),
      drafting_today: draftingTodayTotal,
      sales_days_behind: behind,
    },
    needs,
  };
}

async function sendIt(brief) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, why: 'No TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID set.' };
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: brief.text, disable_web_page_preview: true }),
    });
    const body = await res.json();
    return { sent: !!body.ok, why: body.ok ? null : (body.description || 'Telegram refused it') };
  } catch (e) {
    return { sent: false, why: e.message };
  }
}

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const store_id = q.store_id || 'store1';
  // Netlify's scheduler calls this with no query string.
  const scheduled = !event || !event.queryStringParameters;

  try {
    const brief = await build(store_id);

    // Keep a record whether or not it reaches his phone, so a failed send
    // never means a lost morning.
    await supabase.from('exceptions').insert({
      store_id,
      raised_by: 'daily-brief',
      severity: brief.urgent ? 'warn' : 'info',
      code: 'DAILY_BRIEF',
      message: brief.text,
      suggested_action: brief.needs.length ? brief.needs.join(' | ') : 'Nothing today',
      status: brief.urgent ? 'open' : 'resolved',
    });

    let delivery = { sent: false, why: 'not requested' };
    if (scheduled || q.send === '1') delivery = await sendIt(brief);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(Object.assign({ delivery }, brief)),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, where: 'daily-brief' }),
    };
  }
};

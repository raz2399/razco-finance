// Netlify Function: weekly-close
// The Sunday night math, done once and then locked.
//
//   cash on hand + income - expense = left on hand
//
// Route: /.netlify/functions/weekly-close
//   GET  ?store_id=store1&week_start=YYYY-MM-DD  -> the numbers, and whether
//                                                   the week is already closed
//   POST { store_id, week_start, cash_on_hand, note }  -> close it
//   POST { store_id, week_start, action: "reopen" }    -> unlock it
//
// A closed week is a statement of fact about a week that has ended. Once it
// is written, nothing recomputes it: a late invoice entered next month must
// not silently change what last month said. Reopening is deliberate.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => d.toISOString().split('T')[0];
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

function mondayOf(d) {
  const x = new Date(d.getTime());
  const dow = x.getUTCDay();
  x.setUTCDate(x.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return x;
}
function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

let schemaCache = null;
async function schema() {
  if (schemaCache) return schemaCache;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/', {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' },
  });
  const spec = await res.json();
  schemaCache = spec.definitions || {};
  return schemaCache;
}
function onlyRealColumns(row, columns) {
  const out = {};
  Object.keys(row).forEach((k) => { if (columns[k]) out[k] = row[k]; });
  return out;
}

// Everything the week adds up to. Used both to preview a close and to
// freeze one.
async function weekNumbers(store_id, ws, we) {
  const [tenderTypesRes, tenderRes, invoicesRes, paymentsRes, accountsRes] = await Promise.all([
    supabase.from('tender_types').select('tender_id, bucket'),
    supabase.from('tender_daily').select('business_date, tender_id, tender_amount')
      .eq('store_id', store_id).gte('business_date', ws).lte('business_date', we),
    supabase.from('invoices')
      .select('invoice_id, total_amount, balance_due, status, received_date, invoice_date, payment_type')
      .eq('store_id', store_id),
    supabase.from('payments')
      .select('payment_id, method, amount, status, cleared_date, payment_date')
      .eq('store_id', store_id),
    supabase.from('bank_accounts').select('account_id, current_balance, balance_as_of')
      .eq('store_id', store_id).eq('active', true),
  ]);

  const bucketOf = {};
  (tenderTypesRes.data || []).forEach((t) => { bucketOf[String(t.tender_id)] = t.bucket || 'other'; });

  let cash = 0, card = 0, chk = 0;
  (tenderRes.data || []).forEach((r) => {
    const b = bucketOf[String(r.tender_id)] || 'other';
    const amt = money(r.tender_amount);
    if (b === 'cash') cash += amt;
    else if (b === 'check') chk += amt;
    else if (b === 'other') { /* coupons are not money taken in */ }
    else card += amt;
  });
  const income = money(cash + card + chk);

  const invoices = invoicesRes.data || [];
  const weekInvoices = invoices.filter((i) => {
    const d = i.received_date || i.invoice_date;
    return d >= ws && d <= we && i.status !== 'void';
  });
  const expense = money(weekInvoices.reduce((s, i) => s + money(i.total_amount), 0));

  const payments = paymentsRes.data || [];
  const outstanding = payments.filter(
    (p) => p.method === 'check' && !p.cleared_date && p.status !== 'void' && p.status !== 'cleared'
  );
  const checksOut = money(outstanding.reduce((s, p) => s + money(p.amount), 0));

  const openInvoices = invoices.filter(
    (i) => i.status !== 'paid' && i.status !== 'void' && money(i.balance_due) > 0
  );
  const apOpen = money(openInvoices.reduce((s, i) => s + money(i.balance_due), 0));

  const acct = (accountsRes.data || [])[0] || null;
  const inBank = acct ? money(acct.current_balance) : 0;

  return {
    cash: money(cash), card: money(card), check: money(chk),
    income, expense,
    net: money(income - expense),
    in_bank: inBank,
    bank_as_of: acct ? acct.balance_as_of : null,
    outstanding_checks: checksOut,
    outstanding_checks_count: outstanding.length,
    open_ap: apOpen,
    open_ap_count: openInvoices.length,
    after_checks_clear: money(inBank - checksOut),
    after_everything: money(inBank - checksOut - apOpen),
    invoice_count: weekInvoices.length,
    days_with_sales: new Set((tenderRes.data || []).map((r) => r.business_date)).size,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const q = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};
    const store_id = body.store_id || q.store_id || 'store1';

    const startRaw = body.week_start || q.week_start;
    const weekStart = startRaw ? new Date(startRaw + 'T00:00:00Z') : mondayOf(new Date());
    const ws = iso(weekStart);
    const we = iso(addDays(weekStart, 6));
    const today = iso(new Date());

    const existingRes = await supabase
      .from('weekly_close').select('*')
      .eq('store_id', store_id).eq('week_start', ws).limit(1);
    const existing = (existingRes.data || [])[0] || null;

    // ---------------- GET: show me the week ----------------
    if (event.httpMethod === 'GET') {
      const n = await weekNumbers(store_id, ws, we);
      return json(200, {
        store_id, week_start: ws, week_end: we, today,
        week_is_over: today > we,
        closed: !!(existing && existing.status === 'closed'),
        closed_at: existing ? existing.closed_at : null,
        // A closed week reports what was written down, not what the data
        // says today. That is the whole point of closing it.
        frozen: existing && existing.status === 'closed' ? {
          net_sales: money(existing.net_sales),
          operating_exp: money(existing.operating_exp),
          operating_profit: money(existing.operating_profit),
          cash_position: money(existing.cash_position),
          outstanding_checks: money(existing.outstanding_checks),
          open_ap: money(existing.open_ap),
        } : null,
        live: n,
        // What the close would say if run right now.
        preview: {
          formula: 'cash on hand + income - expense = left on hand',
          income: n.income,
          expense: n.expense,
          left_on_hand_without_cash: n.net,
        },
        warnings: [
          today <= we ? 'This week is not over yet — closing it now freezes a partial week.' : null,
          n.days_with_sales === 0 ? 'No register sales landed for this week.' : null,
          n.days_with_sales > 0 && n.days_with_sales < 7
            ? 'Only ' + n.days_with_sales + ' of 7 days have register sales.' : null,
          !n.bank_as_of ? 'No bank balance on file, so the cash position is not real yet.' : null,
        ].filter(Boolean),
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Use GET or POST.' });

    // ---------------- POST reopen ----------------
    if (body.action === 'reopen') {
      if (!existing) return json(404, { error: 'That week was never closed.' });
      const up = await supabase.from('weekly_close')
        .update({ status: 'open' }).eq('close_id', existing.close_id);
      if (up.error) return json(500, { error: 'Could not reopen: ' + up.error.message });
      return json(200, { success: true, reopened: ws });
    }

    // ---------------- POST close ----------------
    if (existing && existing.status === 'closed' && !body.force) {
      return json(409, {
        error: 'That week is already closed.',
        closed_at: existing.closed_at,
        hint: 'Reopen it first if the numbers need to change.',
      });
    }

    const n = await weekNumbers(store_id, ws, we);

    // Cash in the drawer and the safe is the one number no system can see.
    // Without it the formula is incomplete, so it is required rather than
    // quietly assumed to be zero.
    if (body.cash_on_hand === undefined || body.cash_on_hand === null || body.cash_on_hand === '') {
      return json(400, {
        error: 'How much cash is on hand? Nothing can read that, so the week cannot close without it.',
        needs: 'cash_on_hand',
        week: n,
      });
    }
    const cashOnHand = money(body.cash_on_hand);
    const leftOnHand = money(cashOnHand + n.income - n.expense);

    const defs = await schema();
    const row = onlyRealColumns({
      store_id,
      week_start: ws,
      week_end: we,
      net_sales: n.income,
      operating_exp: n.expense,
      operating_profit: n.net,
      cash_position: leftOnHand,
      outstanding_checks: n.outstanding_checks,
      open_ap: n.open_ap,
      pending_settlements: n.card,
      status: 'closed',
      closed_at: new Date().toISOString(),
    }, (defs.weekly_close || {}).properties || {});

    let saved;
    if (existing) {
      saved = await supabase.from('weekly_close').update(row)
        .eq('close_id', existing.close_id).select('close_id');
    } else {
      saved = await supabase.from('weekly_close').insert(row).select('close_id');
    }
    if (saved.error) return json(500, { error: 'Could not close the week: ' + saved.error.message });

    return json(200, {
      success: true,
      week_start: ws,
      week_end: we,
      closed_at: row.closed_at,
      math: {
        cash_on_hand: cashOnHand,
        income: n.income,
        expense: n.expense,
        left_on_hand: leftOnHand,
        sentence: '$' + cashOnHand.toLocaleString() + ' on hand + $' + n.income.toLocaleString() +
                  ' income - $' + n.expense.toLocaleString() + ' expense = $' + leftOnHand.toLocaleString() +
                  ' left on hand',
      },
      position: {
        in_bank: n.in_bank,
        outstanding_checks: n.outstanding_checks,
        after_checks_clear: n.after_checks_clear,
        open_ap: n.open_ap,
        after_everything: n.after_everything,
      },
    });
  } catch (err) {
    return json(500, { error: err.message, where: 'weekly-close' });
  }
};

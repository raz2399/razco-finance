// Netlify Function: overview
// Everything the dashboard needs, in one call.
// Route: /.netlify/functions/overview?store_id=store1&week_start=YYYY-MM-DD
//
// Returns:
//   week      - Mon..Sun rows: cash, card, check, income, expense, running
//   position  - in_bank, checks_outstanding, after_checks_clear, ap_open, after_everything
//   checks    - checks written that have not cleared
//   vendors   - what is owed, by vendor
//   alerts    - the "Needs you" list
//   ledger    - one chronological list of everything that moved money
//   freshness - how current each source is

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => d.toISOString().split('T')[0];

// Monday of the week containing `d`. Raz's week runs Monday -> Sunday night.
function mondayOf(d) {
  const x = new Date(d.getTime());
  const dow = x.getUTCDay();             // 0 Sun .. 6 Sat
  const back = dow === 0 ? 6 : dow - 1;  // Sunday belongs to the week that started 6 days ago
  x.setUTCDate(x.getUTCDate() - back);
  return x;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const q = event.queryStringParameters || {};
    const store_id = q.store_id || 'store1';

    const today = iso(new Date());
    const weekStart = q.week_start ? new Date(q.week_start + 'T00:00:00Z') : mondayOf(new Date());
    const weekEnd = addDays(weekStart, 6);
    const ws = iso(weekStart);
    const we = iso(weekEnd);

    // ---- pull everything in parallel ----------------------------------------
    const [
      tenderTypesRes,
      tenderRes,
      invoicesRes,
      vendorsRes,
      paymentsRes,
      accountsRes,
      syncRes,
      trendRes,
    ] = await Promise.all([
      supabase.from('tender_types').select('tender_id, description, bucket, sort_order'),
      supabase.from('tender_daily')
        .select('business_date, tender_id, tender_amount')
        .eq('store_id', store_id).gte('business_date', ws).lte('business_date', we),
      supabase.from('invoices')
        .select('invoice_id, vendor_id, invoice_number, invoice_date, received_date, due_date, total_amount, balance_due, status, payment_type')
        .eq('store_id', store_id),
      supabase.from('vendors').select('vendor_id, name, payment_type, terms_code, terms_days').eq('store_id', store_id),
      supabase.from('payments')
        .select('payment_id, method, payment_date, amount, vendor_id, check_number, memo, status, cleared_date')
        .eq('store_id', store_id),
      supabase.from('bank_accounts')
        .select('account_id, nickname, last_four, current_balance, balance_as_of, next_check_number')
        .eq('store_id', store_id).eq('active', true),
      supabase.from('store_sync').select('synced_at, business_date, status').eq('store_id', store_id).limit(1),
      supabase.from('tender_daily')
        .select('business_date, tender_amount')
        .eq('store_id', store_id).gte('business_date', iso(addDays(weekStart, -56))).lte('business_date', we),
    ]);

    const bucketOf = {};
    const nameOf = {};
    (tenderTypesRes.data || []).forEach((t) => {
      bucketOf[String(t.tender_id)] = t.bucket || 'other';
      nameOf[String(t.tender_id)] = t.description;
    });

    const invoices = invoicesRes.data || [];
    const vendors = vendorsRes.data || [];
    const payments = paymentsRes.data || [];
    const accounts = accountsRes.data || [];

    const vendorName = {};
    vendors.forEach((v) => { vendorName[v.vendor_id] = v.name; });

    // ---- week table ---------------------------------------------------------
    const byDay = {};
    for (let i = 0; i < 7; i++) {
      const d = iso(addDays(weekStart, i));
      byDay[d] = { date: d, cash: 0, card: 0, check: 0, income: 0, expense: 0, tenders: {} };
    }

    (tenderRes.data || []).forEach((r) => {
      const row = byDay[r.business_date];
      if (!row) return;
      const amt = money(r.tender_amount);
      const b = bucketOf[String(r.tender_id)] || 'other';
      if (b === 'cash') row.cash += amt;
      else if (b === 'check') row.check += amt;
      else if (b === 'other') { /* vendor coupons are not money in the drawer */ }
      else row.card += amt;
      const label = nameOf[String(r.tender_id)] || ('Tender ' + r.tender_id);
      row.tenders[label] = money((row.tenders[label] || 0) + amt);
    });

    // Expense for a day = invoices received that day. That is what Raz writes
    // in his notebook when a delivery lands, COD or charge alike.
    invoices.forEach((inv) => {
      const d = inv.received_date || inv.invoice_date;
      if (byDay[d]) byDay[d].expense += money(inv.total_amount);
    });

    let wkCash = 0, wkCard = 0, wkCheck = 0, wkIncome = 0, wkExpense = 0;
    const week = [];
    Object.keys(byDay).sort().forEach((d) => {
      const r = byDay[d];
      r.cash = money(r.cash); r.card = money(r.card); r.check = money(r.check);
      r.income = money(r.cash + r.card + r.check);
      r.expense = money(r.expense);
      r.net = money(r.income - r.expense);
      r.has_data = r.income !== 0 || r.expense !== 0;
      wkCash += r.cash; wkCard += r.card; wkCheck += r.check;
      wkIncome += r.income; wkExpense += r.expense;
      week.push(r);
    });

    // ---- cash position ------------------------------------------------------
    const acct = accounts[0] || null;
    const inBank = acct ? money(acct.current_balance) : 0;

    const outstanding = payments.filter(
      (p) => p.method === 'check' && !p.cleared_date && p.status !== 'void' && p.status !== 'cleared'
    );
    const checksOut = money(outstanding.reduce((s, p) => s + money(p.amount), 0));

    const openInvoices = invoices.filter(
      (i) => i.status !== 'paid' && i.status !== 'void' && money(i.balance_due) > 0
    );
    const apOpen = money(openInvoices.reduce((s, i) => s + money(i.balance_due), 0));

    // Money that leaves on its own versus money that waits for Raz to write a
    // check. Both are owed, but only one of them is a job.
    const isAutomatic = (i) => i.payment_type === 'cod_draft' || i.payment_type === 'auto_debit';
    const draftInvoices = openInvoices.filter(isAutomatic);
    const checkInvoices = openInvoices.filter((i) => !isAutomatic(i));
    const draftsPending = money(draftInvoices.reduce((s, i) => s + money(i.balance_due), 0));
    const checksToWrite = money(checkInvoices.reduce((s, i) => s + money(i.balance_due), 0));

    const afterChecks = money(inBank - checksOut);
    const afterEverything = money(afterChecks - apOpen);

    // ---- owed by vendor -----------------------------------------------------
    const owedMap = {};
    openInvoices.forEach((i) => {
      const key = i.vendor_id || 'unknown';
      if (!owedMap[key]) {
        owedMap[key] = { vendor_id: i.vendor_id, name: vendorName[i.vendor_id] || 'Unassigned',
                         amount: 0, count: 0, next_due: null, automatic: isAutomatic(i) };
      }
      owedMap[key].amount = money(owedMap[key].amount + money(i.balance_due));
      owedMap[key].count += 1;
      if (i.due_date && (!owedMap[key].next_due || i.due_date < owedMap[key].next_due)) {
        owedMap[key].next_due = i.due_date;
      }
    });
    const owed = Object.keys(owedMap).map((k) => owedMap[k]).sort((a, b) => b.amount - a.amount);

    // ---- alerts: the "Needs you" list ---------------------------------------
    const alerts = [];

    if (checksOut > 0 && afterChecks < 0) {
      alerts.push({
        level: 'critical',
        title: 'Not enough in the bank for the checks you wrote',
        detail: 'Checks still out total $' + checksOut.toLocaleString() +
                ' against $' + inBank.toLocaleString() + ' in the bank.',
        action: 'Move money in or hold a check',
      });
    }

    // Invoices you still have to write a check for.
    checkInvoices.forEach((i) => {
      if (!i.due_date) return;
      const days = daysBetween(today, i.due_date);
      if (days < 0) {
        alerts.push({
          level: 'critical',
          title: (vendorName[i.vendor_id] || 'A vendor') + ' is past due',
          detail: '$' + money(i.balance_due).toLocaleString() + ' was due ' + i.due_date + '.',
          action: 'Pay now',
          invoice_id: i.invoice_id,
        });
      } else if (days <= 3) {
        alerts.push({
          level: 'warn',
          title: (vendorName[i.vendor_id] || 'A vendor') + ' due in ' + (days === 0 ? 'today' : days + ' day' + (days === 1 ? '' : 's')),
          detail: '$' + money(i.balance_due).toLocaleString() + ' due ' + i.due_date + '.',
          action: 'Write the check',
          invoice_id: i.invoice_id,
        });
      }
    });

    // Money that leaves on its own. Nothing to do except have it there — so
    // this never says "write the check", and it goes critical when the bank
    // would not cover it.
    draftInvoices.forEach((i) => {
      if (!i.due_date) return;
      const days = daysBetween(today, i.due_date);
      if (days > 2) return;
      const amt = money(i.balance_due);
      const when = days < 0 ? 'should have drafted ' + i.due_date
                 : days === 0 ? 'drafts today'
                 : days === 1 ? 'drafts tomorrow'
                 : 'drafts ' + i.due_date;
      alerts.push({
        level: amt > inBank ? 'critical' : 'warn',
        title: (vendorName[i.vendor_id] || 'A vendor') + ' ' + when,
        detail: '$' + amt.toLocaleString() + ' comes straight out of the account. No check to write.',
        action: amt > inBank ? 'Not enough in the bank' : 'Make sure it is there',
        invoice_id: i.invoice_id,
      });
    });

    const sync = (syncRes.data || [])[0] || null;
    const lastSalesDay = week.filter((r) => r.has_data).map((r) => r.date).pop() ||
                         (sync ? sync.business_date : null);
    if (sync && sync.business_date) {
      const behind = daysBetween(sync.business_date, today);
      if (behind > 1) {
        alerts.push({
          level: 'warn',
          title: 'Sales have not come in for ' + behind + ' days',
          detail: 'Last day received from the register was ' + sync.business_date + '.',
          action: 'Check the store PC sync',
        });
      }
    }

    if (!acct) {
      alerts.push({
        level: 'warn',
        title: 'No bank balance on file',
        detail: 'Import a statement or set the balance so the cash numbers are real.',
        action: 'Open Bank',
      });
    }

    outstanding.forEach((p) => {
      if (!p.payment_date) return;
      const age = daysBetween(p.payment_date, today);
      if (age > 30) {
        alerts.push({
          level: 'warn',
          title: 'Check #' + (p.check_number || '?') + ' has not cleared in ' + age + ' days',
          detail: '$' + money(p.amount).toLocaleString() + ' to ' + (vendorName[p.vendor_id] || p.memo || 'vendor') + '.',
          action: 'Follow up or void',
          payment_id: p.payment_id,
        });
      }
    });

    // Note: a plain `order[x] || 3` would turn critical (0) into 3 and bury it.
    const order = { critical: 0, warn: 1, info: 2 };
    const rank = (lvl) => (order[lvl] === undefined ? 3 : order[lvl]);
    alerts.sort((a, b) => rank(a.level) - rank(b.level));

    // ---- one chronological ledger -------------------------------------------
    const ledger = [];
    week.forEach((r) => {
      if (r.income > 0) {
        ledger.push({ date: r.date, kind: 'sales', label: 'Register sales', in: r.income, out: 0,
                      detail: 'Cash $' + r.cash.toLocaleString() + ' / Card $' + r.card.toLocaleString() });
      }
    });
    invoices.forEach((i) => {
      const d = i.received_date || i.invoice_date;
      if (d >= ws && d <= we) {
        ledger.push({ date: d, kind: 'invoice', label: (vendorName[i.vendor_id] || 'Vendor') + ' invoice ' + (i.invoice_number || ''),
                      in: 0, out: money(i.total_amount), detail: i.payment_type === 'cod' ? 'COD' : 'Charge' });
      }
    });
    payments.forEach((p) => {
      if (p.payment_date >= ws && p.payment_date <= we && p.status !== 'void') {
        ledger.push({ date: p.payment_date, kind: 'payment',
                      label: (p.method === 'check' ? 'Check #' + (p.check_number || '?') : 'Draft') + ' — ' + (vendorName[p.vendor_id] || p.memo || ''),
                      in: 0, out: money(p.amount),
                      detail: p.cleared_date ? 'Cleared ' + p.cleared_date : 'Not cleared yet' });
      }
    });
    ledger.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // ---- 8 week sales trend --------------------------------------------------
    const trendMap = {};
    (trendRes.data || []).forEach((r) => {
      const m = iso(mondayOf(new Date(r.business_date + 'T00:00:00Z')));
      trendMap[m] = money((trendMap[m] || 0) + money(r.tender_amount));
    });
    const trend = Object.keys(trendMap).sort().map((k) => ({ week_start: k, sales: trendMap[k] }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        store_id,
        today,
        week_start: ws,
        week_end: we,
        week,
        week_totals: {
          cash: money(wkCash), card: money(wkCard), check: money(wkCheck),
          income: money(wkIncome), expense: money(wkExpense),
          left_on_hand: money(wkIncome - wkExpense),
        },
        position: {
          in_bank: inBank,
          bank_label: acct ? (acct.nickname + (acct.last_four ? ' ••' + acct.last_four : '')) : null,
          balance_as_of: acct ? acct.balance_as_of : null,
          checks_outstanding: checksOut,
          checks_outstanding_count: outstanding.length,
          after_checks_clear: afterChecks,
          ap_open: apOpen,
          ap_open_count: openInvoices.length,
          drafts_pending: draftsPending,
          drafts_pending_count: draftInvoices.length,
          checks_to_write: checksToWrite,
          checks_to_write_count: checkInvoices.length,
          after_everything: afterEverything,
          next_check_number: acct ? acct.next_check_number : null,
        },
        checks: outstanding
          .sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1))
          .map((p) => ({
            payment_id: p.payment_id, check_number: p.check_number, amount: money(p.amount),
            payment_date: p.payment_date, payee: vendorName[p.vendor_id] || p.memo || '—',
            days_out: p.payment_date ? daysBetween(p.payment_date, today) : null,
          })),
        vendors: owed,
        alerts,
        ledger,
        trend,
        freshness: {
          last_sales_day: lastSalesDay,
          last_sync: sync ? sync.synced_at : null,
          sales_days_behind: sync && sync.business_date ? daysBetween(sync.business_date, today) : null,
          bank_as_of: acct ? acct.balance_as_of : null,
          tender_names_loaded: Object.keys(bucketOf).length,
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message, where: 'overview' }),
    };
  }
};

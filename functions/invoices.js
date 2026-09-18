// Netlify Function: invoices
// Charge-account core: capture an invoice, remember the vendor's terms,
// and let a payment run turn what is due into checks.
// Route: /.netlify/functions/invoices
//   GET  ?store_id=store1[&status=open|all]  -> invoices + vendor summary
//   POST { store_id, vendor, invoice_number, invoice_date, total_amount,
//          terms_code, terms_days, payment_type, notes }      -> log an invoice
//   POST { store_id, action:"pay", invoice_ids:[...], check_number, payment_date }
//   POST { store_id, action:"void", invoice_id }

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const todayStr = () => new Date().toISOString().split('T')[0];
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

function fillRequired(row, def, text, today) {
  const required = def.required || [];
  const props = def.properties || {};
  required.forEach((key) => {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return;
    const p = props[key] || {};
    if (p.default !== undefined) return;
    const kind = String(p.format || p.type || '').toLowerCase();
    if (kind.includes('uuid')) row[key] = crypto.randomUUID();
    else if (/int|numeric|double|real|float|money|decimal/.test(kind)) row[key] = 0;
    else if (/timestamp|date/.test(kind)) row[key] = today;
    else if (kind.includes('bool')) row[key] = false;
    else row[key] = text;
  });
}

// Terms -> due date. Mirrors ap-calendar so both agree.
function dueDateFrom(invoiceDate, termsCode, termsDays) {
  const inv = new Date(invoiceDate + 'T12:00:00Z');
  let due = new Date(inv);

  if (termsCode === 'cod') {
    due = new Date(inv);
  } else if (termsCode === 'eom') {
    due = new Date(Date.UTC(inv.getUTCFullYear(), inv.getUTCMonth() + 1, 0, 12));
  } else if (termsCode === 'prox10') {
    due = new Date(Date.UTC(inv.getUTCFullYear(), inv.getUTCMonth() + 1, 10, 12));
  } else if (termsCode === 'weekly') {
    due.setUTCDate(inv.getUTCDate() + 7);
  } else {
    due.setUTCDate(inv.getUTCDate() + (Number(termsDays) || 30));
  }

  const dow = due.getUTCDay();
  if (dow === 6) due.setUTCDate(due.getUTCDate() - 1);
  if (dow === 0) due.setUTCDate(due.getUTCDate() - 2);

  return due.toISOString().split('T')[0];
}

const TERMS_DAYS = { cod: 0, net7: 7, net10: 10, net15: 15, net30: 30 };

// How a vendor takes its money. Set once per vendor, then the dock screen
// tells whoever receives the delivery exactly what to do.
//   cod        - write a check at the door
//   check      - charge account, we write a check when terms come due
//   auto_debit - the bank drafts it on the due date, no check is ever written
const PAY_METHODS = { cod: 1, check: 1, auto_debit: 1 };

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// Find a vendor by name (case-insensitive), or create one carrying the terms.
async function resolveVendor(store_id, name, termsCode, termsDays, paymentType, defs) {
  const all = await supabase
    .from('vendors')
    .select('vendor_id, name, payment_type, terms_code, terms_days')
    .eq('store_id', store_id);

  const wanted = String(name).trim().toLowerCase();
  const hit = (all.data || []).find((v) => String(v.name || '').trim().toLowerCase() === wanted);
  if (hit) return { vendor: hit, created: false };

  const row = onlyRealColumns(
    {
      store_id,
      name: String(name).trim(),
      code: String(name).trim().substring(0, 12).toUpperCase().replace(/[^A-Z0-9]/g, ''),
      payment_type: paymentType || 'charge',
      terms_code: termsCode || 'net30',
      terms_days: termsDays,
      active: true,
    },
    (defs.vendors || {}).properties || {}
  );
  fillRequired(row, defs.vendors || {}, String(name).trim(), todayStr());

  const ins = await supabase.from('vendors').insert(row).select('vendor_id, name, payment_type, terms_code, terms_days');
  if (ins.error) throw new Error('Could not create the vendor: ' + ins.error.message);
  return { vendor: ins.data[0], created: true };
}

exports.handler = async (event) => {
  try {
    // ------------------------------- GET ---------------------------------
    if (event.httpMethod === 'GET') {
      const { store_id, status } = event.queryStringParameters || {};
      if (!store_id) return json(400, { error: 'Missing store_id' });

      // Always read everything: a paid COD bill still has to reach QuickBooks,
      // so the QB queue cannot be built from open invoices alone.
      const res = await supabase
        .from('invoices')
        .select('invoice_id, invoice_number, vendor_id, invoice_date, due_date, total_amount, amount_paid, balance_due, status, payment_type, qb_synced, notes')
        .eq('store_id', store_id)
        .order('due_date', { ascending: true })
        .limit(300);
      if (res.error) return json(500, { error: res.error.message });

      const vend = await supabase
        .from('vendors')
        .select('vendor_id, name, payment_type, terms_code, terms_days')
        .eq('store_id', store_id);

      const byId = {};
      (vend.data || []).forEach((v) => { byId[v.vendor_id] = v; });

      const today = todayStr();
      const rows = (res.data || []).map((r) => {
        const v = byId[r.vendor_id] || {};
        const overdue = r.due_date && r.due_date < today;
        return {
          invoice_id: r.invoice_id,
          invoice_number: r.invoice_number,
          vendor_name: v.name || 'Unknown vendor',
          terms: v.terms_code || '',
          invoice_date: r.invoice_date,
          due_date: r.due_date,
          total_amount: round(r.total_amount),
          balance_due: round(r.balance_due),
          status: r.status,
          pay_method: r.payment_type || v.payment_type || 'check',
          overdue: !!overdue,
          qb_synced: !!r.qb_synced,
          notes: r.notes || '',
        };
      });

      // The three questions you have every morning:
      //   1. what must I write checks for
      //   2. what the bank is going to take on its own
      //   3. what still has to go into QuickBooks
      const openStatuses = ['approved', 'scheduled', 'partially_paid'];
      const openRows = rows.filter((r) => openStatuses.indexOf(r.status) >= 0);

      const inDays = function (n) {
        const d = new Date(today + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().split('T')[0];
      };
      const weekOut = inDays(7);

      const toPay = openRows
        .filter((r) => r.pay_method === 'check' && r.due_date && r.due_date <= weekOut)
        .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

      const drafts = openRows
        .filter((r) => r.pay_method === 'auto_debit')
        .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));

      const draftsThisWeek = drafts.filter((r) => r.due_date && r.due_date <= weekOut);

      const needsQB = rows
        .filter((r) => !r.qb_synced && r.status !== 'void')
        .sort((a, b) => String(b.invoice_date).localeCompare(String(a.invoice_date)));

      // What you owe, grouped by vendor — the charge-account view.
      const byVendor = {};
      rows.forEach((r) => {
        if (['approved', 'scheduled', 'partially_paid'].indexOf(r.status) < 0) return;
        if (!byVendor[r.vendor_name]) {
          byVendor[r.vendor_name] = { vendor_name: r.vendor_name, terms: r.terms, pay_method: r.pay_method, open_invoices: 0, balance: 0, oldest_due: null, overdue: 0 };
        }
        const g = byVendor[r.vendor_name];
        g.open_invoices++;
        g.balance += r.balance_due;
        if (r.overdue) g.overdue++;
        if (!g.oldest_due || (r.due_date && r.due_date < g.oldest_due)) g.oldest_due = r.due_date;
      });

      const vendors = Object.keys(byVendor).map((k) => {
        byVendor[k].balance = round(byVendor[k].balance);
        return byVendor[k];
      }).sort((a, b) => b.balance - a.balance);

      const totalOwed = rows
        .filter((r) => ['approved', 'scheduled', 'partially_paid'].indexOf(r.status) >= 0)
        .reduce((s, r) => s + r.balance_due, 0);

      const dueThisWeek = rows.filter((r) => {
        if (!r.due_date) return false;
        const d = new Date(r.due_date + 'T12:00:00Z');
        const limit = new Date(today + 'T12:00:00Z');
        limit.setUTCDate(limit.getUTCDate() + 7);
        return d <= limit && ['approved', 'scheduled', 'partially_paid'].indexOf(r.status) >= 0;
      });

      return json(200, {
        store_id,
        to_pay: toPay,
        to_pay_total: round(toPay.reduce((a, r) => a + r.balance_due, 0)),
        auto_drafts: drafts,
        auto_drafts_this_week: draftsThisWeek,
        auto_drafts_this_week_total: round(draftsThisWeek.reduce((a, r) => a + r.balance_due, 0)),
        auto_drafts_total: round(drafts.reduce((a, r) => a + r.balance_due, 0)),
        needs_qb: needsQB,
        needs_qb_count: needsQB.length,
        total_owed: round(totalOwed),
        open_count: rows.filter((r) => ['approved', 'scheduled', 'partially_paid'].indexOf(r.status) >= 0).length,
        overdue_count: rows.filter((r) => r.overdue).length,
        due_this_week_count: dueThisWeek.length,
        due_this_week_total: round(dueThisWeek.reduce((s, r) => s + r.balance_due, 0)),
        vendors,
        invoices: rows,
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' });

    const body = JSON.parse(event.body || '{}');
    const { store_id } = body;
    if (!store_id) return json(400, { error: 'Missing store_id' });

    const defs = await schema();

    // ------------------------------- VOID --------------------------------
    if (body.action === 'void') {
      if (!body.invoice_id) return json(400, { error: 'Missing invoice_id' });
      const res = await supabase
        .from('invoices')
        .update({ status: 'void', balance_due: 0 })
        .eq('invoice_id', body.invoice_id)
        .eq('store_id', store_id);
      if (res.error) return json(500, { error: res.error.message });
      return json(200, { success: true, invoice_id: body.invoice_id });
    }

    // ------------------------------- PAY ---------------------------------
    // Turns selected invoices into one check, already carrying the vendor and
    // the amount. This is why you never hand-type a check.
    if (body.action === 'pay') {
      const ids = body.invoice_ids || [];
      if (!ids.length) return json(400, { error: 'No invoices selected' });
      if (!body.check_number) return json(400, { error: 'Check number is required' });

      const sel = await supabase
        .from('invoices')
        .select('invoice_id, invoice_number, vendor_id, balance_due, status')
        .eq('store_id', store_id)
        .in('invoice_id', ids);

      if (sel.error) return json(500, { error: sel.error.message });
      const picked = (sel.data || []).filter((r) => Number(r.balance_due) > 0);
      if (!picked.length) return json(400, { error: 'Those invoices have nothing left to pay' });

      const vendorIds = {};
      picked.forEach((p) => { vendorIds[p.vendor_id] = 1; });
      if (Object.keys(vendorIds).length > 1) {
        return json(400, { error: 'One check pays one vendor. Select invoices for a single vendor.' });
      }

      const amount = round(picked.reduce((s, p) => s + Number(p.balance_due), 0));
      const payDate = body.payment_date || todayStr();

      const vend = await supabase
        .from('vendors').select('name').eq('vendor_id', picked[0].vendor_id).limit(1).maybeSingle();
      const vendorName = vend.data ? vend.data.name : 'Vendor';

      const acct = await supabase
        .from('bank_accounts').select('account_id').eq('store_id', store_id).limit(1).maybeSingle();

      const payRow = onlyRealColumns(
        {
          store_id,
          account_id: acct.data ? acct.data.account_id : null,
          vendor_id: picked[0].vendor_id,
          method: 'check',
          check_number: String(body.check_number),
          amount,
          payment_date: payDate,
          memo: vendorName + ' — ' + picked.map((p) => p.invoice_number).join(', '),
          status: 'outstanding',
          issued_at: new Date(payDate + 'T12:00:00Z').toISOString(),
        },
        (defs.payments || {}).properties || {}
      );
      if (payRow.account_id === null) delete payRow.account_id;
      fillRequired(payRow, defs.payments || {}, vendorName, payDate);

      const pay = await supabase.from('payments').insert(payRow).select('payment_id, check_number, amount');
      if (pay.error) return json(500, { error: 'Could not create the check: ' + pay.error.message });

      for (const p of picked) {
        await supabase
          .from('invoices')
          .update({ status: 'paid', amount_paid: round(p.balance_due), balance_due: 0 })
          .eq('invoice_id', p.invoice_id);
      }

      return json(200, {
        success: true,
        check: pay.data ? pay.data[0] : null,
        vendor_name: vendorName,
        invoices_paid: picked.length,
        amount,
      });
    }

    // ---------------------------- MARK ENTERED IN QUICKBOOKS ---------------
    if (body.action === 'qb') {
      if (!body.invoice_id) return json(400, { error: 'Missing invoice_id' });
      const res = await supabase
        .from('invoices')
        .update({ qb_synced: true })
        .eq('invoice_id', body.invoice_id)
        .eq('store_id', store_id);
      if (res.error) return json(500, { error: res.error.message });
      return json(200, { success: true, invoice_id: body.invoice_id });
    }

    // ---------------------------- SET HOW A VENDOR IS PAID -----------------
    if (body.action === 'set_vendor') {
      if (!body.vendor) return json(400, { error: 'Missing vendor' });
      const method = PAY_METHODS[body.pay_method] ? body.pay_method : 'check';
      const termsCode = method === 'cod' ? 'cod' : (body.terms_code || 'net30');
      const r = await resolveVendor(store_id, body.vendor, termsCode,
        body.terms_days !== undefined && body.terms_days !== '' ? Number(body.terms_days) : TERMS_DAYS[termsCode],
        method, defs);
      if (!r.created) {
        const upd = await supabase
          .from('vendors')
          .update({ payment_type: method, terms_code: termsCode })
          .eq('vendor_id', r.vendor.vendor_id);
        if (upd.error) return json(500, { error: upd.error.message });
      }
      return json(200, { success: true, vendor_name: r.vendor.name, pay_method: method, terms_code: termsCode, created: r.created });
    }

    // ---------------------------- LOG AN INVOICE ---------------------------
    const vendorName = String(body.vendor || '').trim();
    const invoiceNumber = String(body.invoice_number || '').trim();
    const total = Number(String(body.total_amount || '').replace(/[$,\s]/g, ''));
    const invoiceDate = body.invoice_date || todayStr();

    if (!vendorName) return json(400, { error: 'Vendor is required' });
    if (!invoiceNumber) return json(400, { error: 'Invoice number is required' });
    if (!total || isNaN(total) || total <= 0) return json(400, { error: 'Amount must be a positive number' });

    // Does this vendor already exist? If so, its stored method wins — the
    // person at the dock should not have to know or decide.
    const known = await supabase
      .from('vendors')
      .select('vendor_id, name, payment_type, terms_code, terms_days')
      .eq('store_id', store_id);

    const wanted = vendorName.toLowerCase();
    const existing = (known.data || []).find((v) => String(v.name || '').trim().toLowerCase() === wanted);

    // New vendor and nobody said how it gets paid: stop and ask, once.
    if (!existing && !body.pay_method) {
      return json(428, {
        error: 'new_vendor',
        message: vendorName + ' has not been set up yet. How does this vendor get paid?',
        vendor: vendorName,
      });
    }

    const payMethod = existing
      ? (PAY_METHODS[existing.payment_type] ? existing.payment_type : 'check')
      : (PAY_METHODS[body.pay_method] ? body.pay_method : 'check');

    const termsCode = payMethod === 'cod'
      ? 'cod'
      : (existing && existing.terms_code ? existing.terms_code : (body.terms_code || 'net30'));

    const termsDays = existing && existing.terms_days !== null && existing.terms_days !== undefined
      ? Number(existing.terms_days)
      : (body.terms_days !== undefined && body.terms_days !== '' ? Number(body.terms_days) : TERMS_DAYS[termsCode]);

    const { vendor, created } = await resolveVendor(store_id, vendorName, termsCode, termsDays, payMethod, defs);

    // Same invoice number from the same vendor is a double-entry.
    const dupe = await supabase
      .from('invoices')
      .select('invoice_id, total_amount, invoice_date')
      .eq('store_id', store_id)
      .eq('vendor_id', vendor.vendor_id)
      .eq('invoice_number', invoiceNumber)
      .limit(1)
      .maybeSingle();

    if (dupe.data && !body.allow_duplicate) {
      return json(409, {
        error: `Invoice ${invoiceNumber} from ${vendor.name} is already logged for $${Number(dupe.data.total_amount).toFixed(2)} on ${dupe.data.invoice_date}.`,
        duplicate_of: dupe.data,
      });
    }

    // A COD delivery is not recorded at all unless the check is written.
    // Nothing half-saved, ever.
    if (payMethod === 'cod' && !body.check_number) {
      return json(400, { error: 'This is a COD vendor — enter the check number you are handing over.' });
    }

    const dueDate = payMethod === 'cod' ? invoiceDate : dueDateFrom(invoiceDate, termsCode, termsDays);

    // COD is settled at the door. Auto-draft is scheduled, not open to pay.
    // A charge account stays open until someone writes a check for it.
    const status = payMethod === 'cod' ? 'paid' : payMethod === 'auto_debit' ? 'scheduled' : 'approved';

    const invRow = onlyRealColumns(
      {
        store_id,
        vendor_id: vendor.vendor_id,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        received_date: body.received_date || todayStr(),
        due_date: dueDate,
        subtotal: total,
        total_amount: total,
        payment_type: payMethod,
        status,
        amount_paid: payMethod === 'cod' ? total : 0,
        balance_due: payMethod === 'cod' ? 0 : total,
        notes: body.notes || '',
        approved_at: new Date().toISOString(),
        qb_synced: false,
      },
      (defs.invoices || {}).properties || {}
    );
    fillRequired(invRow, defs.invoices || {}, invoiceNumber, invoiceDate);

    const ins = await supabase.from('invoices').insert(invRow).select('invoice_id, invoice_number, total_amount, due_date');
    if (ins.error) return json(500, { error: 'Could not save the invoice: ' + ins.error.message });

    const invoiceId = ins.data && ins.data[0] ? ins.data[0].invoice_id : null;
    const acct = await supabase
      .from('bank_accounts').select('account_id').eq('store_id', store_id).limit(1).maybeSingle();

    let createdPayment = null;
    let instruction = '';

    if (payMethod === 'cod') {
      // A check goes out the door with the driver.
      const payRow = onlyRealColumns(
        {
          store_id,
          account_id: acct.data ? acct.data.account_id : null,
          vendor_id: vendor.vendor_id,
          method: 'check',
          check_number: String(body.check_number),
          amount: total,
          payment_date: invoiceDate,
          memo: vendor.name + ' — COD ' + invoiceNumber,
          status: 'outstanding',
          issued_at: new Date(invoiceDate + 'T12:00:00Z').toISOString(),
        },
        (defs.payments || {}).properties || {}
      );
      if (payRow.account_id === null) delete payRow.account_id;
      fillRequired(payRow, defs.payments || {}, vendor.name, invoiceDate);
      const p = await supabase.from('payments').insert(payRow).select('payment_id, check_number, amount');
      if (p.error) return json(500, { error: 'Invoice saved, but the check failed: ' + p.error.message });
      createdPayment = p.data ? p.data[0] : null;
      instruction = 'Check ' + body.check_number + ' handed over. Enter the bill in QuickBooks as paid.';

    } else if (payMethod === 'auto_debit') {
      // The bank will take it on the due date. Schedule it so the cash
      // forecast knows, and so nobody writes a check for it by mistake.
      const payRow = onlyRealColumns(
        {
          store_id,
          account_id: acct.data ? acct.data.account_id : null,
          vendor_id: vendor.vendor_id,
          method: 'auto_debit',
          amount: total,
          payment_date: dueDate,
          memo: vendor.name + ' — auto-draft ' + invoiceNumber,
          status: 'approved',
        },
        (defs.payments || {}).properties || {}
      );
      if (payRow.account_id === null) delete payRow.account_id;
      fillRequired(payRow, defs.payments || {}, vendor.name, dueDate);
      const p = await supabase.from('payments').insert(payRow).select('payment_id, amount');
      if (p.error) return json(500, { error: 'Invoice saved, but the draft schedule failed: ' + p.error.message });
      createdPayment = p.data ? p.data[0] : null;
      instruction = 'Do not pay this one. The bank drafts ' + '$' + total.toFixed(2) + ' on ' + dueDate + '. Enter the bill in QuickBooks.';

    } else {
      instruction = 'File it. Due ' + dueDate + '. Enter the bill in QuickBooks, then write a check when terms come due.';
    }

    const open = await supabase
      .from('invoices')
      .select('balance_due')
      .eq('store_id', store_id)
      .in('status', ['approved', 'scheduled', 'partially_paid']);

    const totalOwed = (open.data || []).reduce((s2, r) => s2 + (Number(r.balance_due) || 0), 0);

    return json(200, {
      success: true,
      invoice: ins.data ? ins.data[0] : null,
      invoice_id: invoiceId,
      vendor_name: vendor.name,
      vendor_created: created,
      pay_method: payMethod,
      terms_code: termsCode,
      due_date: dueDate,
      instruction,
      payment: createdPayment,
      total_owed: round(totalOwed),
      open_count: (open.data || []).length,
    });
  } catch (error) {
    console.error('invoices error:', error);
    return json(500, { error: error.message });
  }
};

// Netlify Function: vendor-entry
//
// Putting lines on a vendor's ledger by hand, fixing them when they are
// wrong, and clearing the ones that were already paid.
//
//   POST { action:"add_invoice",  vendor_id, invoice_number, invoice_date,
//          total_amount, due_date?, notes?, allow_duplicate? }
//   POST { action:"add_payment",  vendor_id, method, payment_date, amount,
//          check_number?, memo?, invoice_ids?, status? }
//   POST { action:"edit",         kind:"invoice"|"payment", id, fields:{...} }
//   POST { action:"settle",       invoice_ids:[...] | vendor_id+all_open,
//          note? }
//   POST { action:"unsettle",     invoice_ids:[...] }
//   POST { action:"pay_now",      vendor_id, invoice_ids:[...], method,
//          payment_date, check_number?, memo? }
//   POST { action:"import",       vendor_id?, sheet:"<csv text>",
//          preview:true|false, settle_already_paid? }
//
// ---------------------------------------------------------------------
// The distinction this file exists to keep straight
//
// There are two different things that both get called "paid", and mixing
// them up puts money in the wrong place:
//
//   settle   -- it was paid, but not through this system. A bill settled
//               before the switchover, or one he has already written a
//               check for in QuickBooks. It clears what he owes and it
//               writes NO payment row, because no money moved here. Put a
//               payment row in and the cash position would show a check
//               leaving the bank that never left it, and the expense would
//               be counted twice -- once in QuickBooks and once here.
//
//   pay_now  -- he is paying it now, from this system. That writes a real
//               payment, with a method and a date and a check number, and
//               it belongs in the cash position and the expense line.
//
// The screens say which is which in those words. "Already paid elsewhere"
// and "Pay it now".
//
// Nothing here deletes. A line entered wrongly is voided, which keeps it
// visible on the ledger marked as void and counting nothing, because a
// line that vanishes is a line he enters again next week.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, storeFor, safely } = require('./lib/guard');
const { readVendorSheet } = require('./lib/sheet');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Lindsay's today, not the server's. From five in the afternoon Pacific the
// server is already on tomorrow's date, and a bill entered at six in the
// evening would be dated the day after it arrived.
const BUSINESS_TZ = 'America/Los_Angeles';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

// Straight from the database's own check constraints. Sending anything
// outside these lists is rejected by Postgres with a message no shopkeeper
// should ever have to read, so it is caught here and named instead.
const PAYMENT_METHODS = ['check', 'ach', 'auto_debit', 'cash', 'card', 'wire'];
const INVOICE_STATUSES = ['captured', 'extracted', 'needs_review', 'approved',
  'scheduled', 'partially_paid', 'paid', 'void', 'disputed'];
const PAYMENT_STATUSES = ['draft', 'pending_approval', 'approved', 'issued',
  'outstanding', 'cleared', 'void', 'stopped'];

// What a person is allowed to change by hand, per kind. Anything not on
// these lists is ignored rather than passed through: balance_due is worked
// out by the database from total_amount minus amount_paid, and writing to
// it fails outright, while store_id and vendor_id decide whose books a
// line lands in and are not for an edit form to move.
const EDITABLE = {
  invoice: ['invoice_number', 'invoice_date', 'due_date', 'total_amount',
            'amount_paid', 'status', 'notes', 'payment_type', 'received_date'],
  payment: ['payment_date', 'amount', 'check_number', 'memo', 'method',
            'status', 'cleared_date'],
};

const TERMS_DAYS = {
  net7: 7, net10: 10, net15: 15, net30: 30, weekly: 7, cod: 0, auto: 0,
  eom: 30, prox10: 40,
};

// A line in the audit trail. Every write here leaves one, so that a figure
// that changed can be traced to the moment somebody changed it.
async function noted(store_id, code, message, entity_type, entity_id, who) {
  try {
    await supabase.from('exceptions').insert({
      store_id: store_id,
      severity: 'info',
      code: code,
      entity_type: entity_type || null,
      entity_id: isUuid(entity_id) ? entity_id : null,
      message: message,
      raised_by: who || 'vendor-entry',
      status: 'acknowledged',
    });
  } catch (e) {
    // The trail failing must not fail the thing it was recording.
    console.error('audit note failed:', e.message);
  }
}

// Works out a due date when he has not given one, from the vendor's terms.
// Returns null when the terms are not known, because a due date nobody
// chose is worse than no due date at all -- it shows up on the calendar as
// a promise he never made.
function dueFrom(invoiceDate, vendor) {
  if (!vendor) return null;
  const days = vendor.terms_days != null
    ? Number(vendor.terms_days)
    : (vendor.terms_code ? TERMS_DAYS[vendor.terms_code] : null);
  if (days == null || isNaN(days)) return null;
  const d = new Date(invoiceDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadVendor(store_id, vendor_id) {
  if (!isUuid(vendor_id)) return null;
  const r = await supabase.from('vendors')
    .select('vendor_id, name, payment_type, terms_code, terms_days')
    .eq('vendor_id', vendor_id).eq('store_id', store_id).maybeSingle();
  return r.data || null;
}

// How much of each invoice is accounted for by a payment recorded here.
// Needed to tell "paid through this system" from "paid elsewhere", which is
// the whole distinction at the top of this file.
async function allocationsFor(invoiceIds) {
  if (!invoiceIds.length) return {};
  const r = await supabase.from('payment_allocations')
    .select('invoice_id, amount').in('invoice_id', invoiceIds);
  const out = {};
  (r.data || []).forEach((a) => {
    out[a.invoice_id] = money((out[a.invoice_id] || 0) + money(a.amount));
  });
  return out;
}

exports.handler = safely('vendor-entry', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (auth.preflight) return json(200, { ok: true });

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Post to this one.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'That was not readable JSON.' }); }

  const store_id = storeFor(auth.user, body.store_id ||
    (event.queryStringParameters || {}).store_id);
  if (!store_id) return json(403, { error: 'Not your store.' });

  const who = (auth.user && auth.user.email) || 'vendor-entry';

  try {
    switch (body.action) {
      case 'add_invoice':   return await addInvoice(store_id, body, who);
      case 'add_payment':   return await addPayment(store_id, body, who);
      case 'edit':          return await edit(store_id, body, who);
      case 'settle':        return await settle(store_id, body, who);
      case 'unsettle':      return await unsettle(store_id, body, who);
      case 'pay_now':       return await payNow(store_id, body, who);
      case 'void':          return await voidLine(store_id, body, who);
      case 'import':        return await importSheet(store_id, body, who);
      default:
        return json(400, {
          error: 'No action given.',
          actions: ['add_invoice', 'add_payment', 'edit', 'settle',
                    'unsettle', 'pay_now', 'void', 'import'],
        });
    }
  } catch (err) {
    console.error('vendor-entry:', err);
    return json(500, { error: err.message, where: 'vendor-entry/' + body.action });
  }
});

// ---------------------------------------------------------------------
// One invoice, by hand

async function addInvoice(store_id, body, who) {
  const vendor = await loadVendor(store_id, body.vendor_id);
  if (!vendor) return json(404, { error: 'Pick a vendor first.' });

  const total = money(String(body.total_amount || '').replace(/[$,\s]/g, ''));
  if (!total || total <= 0) {
    return json(400, { error: 'How much is it for?' });
  }

  const invoiceDate = isDate(body.invoice_date) ? body.invoice_date : today();
  const number = String(body.invoice_number || '').trim() || null;

  // The same invoice number against the same vendor, twice. Nearly always
  // the same bill entered again, so it is stopped and named rather than
  // quietly doubling what he owes -- but he can say go ahead, because
  // vendors do reuse numbers.
  if (number && !body.allow_duplicate) {
    const dupe = await supabase.from('invoices')
      .select('invoice_id, invoice_date, total_amount, status')
      .eq('store_id', store_id).eq('vendor_id', vendor.vendor_id)
      .eq('invoice_number', number).neq('status', 'void').maybeSingle();
    if (dupe.data) {
      return json(409, {
        error: 'Invoice ' + number + ' is already on ' + vendor.name +
               ' for $' + money(dupe.data.total_amount).toFixed(2) +
               ' dated ' + dupe.data.invoice_date + '.',
        duplicate_of: dupe.data.invoice_id,
        ask: 'Send it again with allow_duplicate to enter it anyway.',
      });
    }
  }

  const paid = body.amount_paid != null
    ? money(String(body.amount_paid).replace(/[$,\s]/g, '')) : 0;
  if (paid < 0 || paid > total) {
    return json(400, { error: 'Paid cannot be less than nothing or more than the invoice.' });
  }

  const row = {
    store_id: store_id,
    vendor_id: vendor.vendor_id,
    invoice_number: number,
    invoice_date: invoiceDate,
    received_date: isDate(body.received_date) ? body.received_date : invoiceDate,
    due_date: isDate(body.due_date) ? body.due_date : dueFrom(invoiceDate, vendor),
    total_amount: total,
    amount_paid: paid,
    payment_type: vendor.payment_type === 'unknown' ? null : vendor.payment_type,
    status: paid >= total ? 'paid' : (paid > 0 ? 'partially_paid' : 'approved'),
    notes: String(body.notes || '').trim() || 'Entered by hand',
    entered_by: null,
  };

  const ins = await supabase.from('invoices').insert(row)
    .select('invoice_id, invoice_number, total_amount, balance_due, due_date').single();
  if (ins.error) return json(500, { error: ins.error.message });

  await noted(store_id, 'manual_invoice',
    'Invoice ' + (number || '(no number)') + ' for $' + total.toFixed(2) +
    ' entered by hand against ' + vendor.name,
    'invoice', ins.data.invoice_id, who);

  return json(200, {
    success: true,
    invoice: ins.data,
    vendor: vendor.name,
    says: 'Invoice added to ' + vendor.name + '.',
  });
}

// ---------------------------------------------------------------------
// One payment, by hand

async function addPayment(store_id, body, who) {
  const vendor = await loadVendor(store_id, body.vendor_id);
  if (!vendor) return json(404, { error: 'Pick a vendor first.' });

  const amount = money(String(body.amount || '').replace(/[$,\s]/g, ''));
  if (!amount || amount <= 0) return json(400, { error: 'How much was paid?' });

  const method = PAYMENT_METHODS.indexOf(body.method) > -1 ? body.method : null;
  if (!method) {
    return json(400, {
      error: 'How was it paid?',
      methods: PAYMENT_METHODS,
    });
  }

  const status = PAYMENT_STATUSES.indexOf(body.status) > -1
    ? body.status
    // A check written is outstanding until the bank takes it; anything
    // else -- a draft, a card, cash -- is gone the moment it happens.
    : (method === 'check' ? 'outstanding' : 'cleared');

  const payDate = isDate(body.payment_date) ? body.payment_date : today();

  const ins = await supabase.from('payments').insert({
    store_id: store_id,
    vendor_id: vendor.vendor_id,
    method: method,
    payment_date: payDate,
    amount: amount,
    check_number: body.check_number ? Number(String(body.check_number).replace(/\D/g, '')) || null : null,
    memo: String(body.memo || '').trim() || null,
    status: status,
    cleared_date: status === 'cleared' ? (isDate(body.cleared_date) ? body.cleared_date : payDate) : null,
  }).select('payment_id, amount, method, check_number, payment_date, status').single();
  if (ins.error) return json(500, { error: ins.error.message });

  // Against which invoices, if he said. Without this the payment reduces
  // what he owes but nothing records WHICH bill it settled -- and that is
  // the question a vendor phones up to ask.
  const applied = await applyTo(store_id, vendor.vendor_id,
    ins.data.payment_id, amount, body.invoice_ids);

  await noted(store_id, 'manual_payment',
    method + ' of $' + amount.toFixed(2) + ' to ' + vendor.name +
    (applied.count ? ' against ' + applied.count + ' invoice(s)' : ' not applied to any invoice'),
    'payment', ins.data.payment_id, who);

  return json(200, {
    success: true,
    payment: ins.data,
    applied_to: applied.count,
    applied_total: applied.total,
    left_over: applied.left,
    says: applied.count
      ? 'Payment recorded and put against ' + applied.count + ' invoice' + (applied.count > 1 ? 's' : '') + '.'
      : 'Payment recorded. It is not against any particular invoice.',
  });
}

// Spreads a payment across invoices, oldest first, and writes the
// allocations. Nothing else in the system wrote these for a long time,
// which is why a check could clear without any invoice showing as paid.
async function applyTo(store_id, vendor_id, payment_id, amount, invoiceIds) {
  let pool = money(amount);
  const wanted = Array.isArray(invoiceIds) ? invoiceIds.filter(isUuid) : null;

  let q = supabase.from('invoices')
    .select('invoice_id, total_amount, amount_paid, balance_due, invoice_date, status')
    .eq('store_id', store_id).eq('vendor_id', vendor_id).neq('status', 'void');
  if (wanted && wanted.length) q = q.in('invoice_id', wanted);
  const res = await q;

  const open = (res.data || [])
    .filter((i) => money(i.balance_due) > 0)
    .sort((a, b) => String(a.invoice_date || '') < String(b.invoice_date || '') ? -1 : 1);

  const allocations = [];
  for (const inv of open) {
    if (pool <= 0) break;
    const take = Math.min(pool, money(inv.balance_due));
    if (take <= 0) continue;
    const nowPaid = money(money(inv.amount_paid) + take);
    const up = await supabase.from('invoices').update({
      amount_paid: nowPaid,
      status: nowPaid >= money(inv.total_amount) ? 'paid' : 'partially_paid',
      updated_at: new Date().toISOString(),
    }).eq('invoice_id', inv.invoice_id).eq('store_id', store_id);
    if (up.error) continue;
    allocations.push({ payment_id: payment_id, invoice_id: inv.invoice_id, amount: take });
    pool = money(pool - take);
  }

  if (allocations.length) {
    const ins = await supabase.from('payment_allocations').insert(allocations);
    if (ins.error) console.error('allocation insert failed:', ins.error.message);
  }

  return {
    count: allocations.length,
    total: money(allocations.reduce((s, a) => s + a.amount, 0)),
    left: money(pool),
  };
}

// ---------------------------------------------------------------------
// Fixing a line

async function edit(store_id, body, who) {
  const kind = body.kind === 'payment' ? 'payment' : 'invoice';
  const id = body.id;
  if (!isUuid(id)) return json(400, { error: 'Which line?' });

  const table = kind === 'invoice' ? 'invoices' : 'payments';
  const idCol = kind === 'invoice' ? 'invoice_id' : 'payment_id';

  const before = await supabase.from(table).select('*')
    .eq(idCol, id).eq('store_id', store_id).maybeSingle();
  if (!before.data) return json(404, { error: 'No such line on your books.' });

  const fields = body.fields || {};
  const patch = {};
  const refused = [];

  Object.keys(fields).forEach((k) => {
    if (EDITABLE[kind].indexOf(k) === -1) { refused.push(k); return; }
    let v = fields[k];

    if (/_date$/.test(k)) {
      if (v === '' || v === null) { patch[k] = null; return; }
      if (!isDate(v)) { refused.push(k + ' (not a date)'); return; }
      patch[k] = v;
      return;
    }
    if (k === 'total_amount' || k === 'amount_paid' || k === 'amount') {
      const n = money(String(v).replace(/[$,\s]/g, ''));
      if (isNaN(n) || n < 0) { refused.push(k + ' (not an amount)'); return; }
      patch[k] = n;
      return;
    }
    if (k === 'check_number') {
      patch[k] = v === '' || v == null ? null : (Number(String(v).replace(/\D/g, '')) || null);
      return;
    }
    if (k === 'status') {
      const list = kind === 'invoice' ? INVOICE_STATUSES : PAYMENT_STATUSES;
      if (list.indexOf(v) === -1) { refused.push(k + ' (not a status)'); return; }
      patch[k] = v;
      return;
    }
    if (k === 'method') {
      if (PAYMENT_METHODS.indexOf(v) === -1) { refused.push(k + ' (not a method)'); return; }
      patch[k] = v;
      return;
    }
    patch[k] = v === '' ? null : v;
  });

  if (!Object.keys(patch).length) {
    return json(400, { error: 'Nothing to change.', refused: refused });
  }

  // An invoice cannot have been paid more than it is for. Checked here
  // against whichever of the two figures is actually changing, because
  // editing one without the other is the normal case.
  if (kind === 'invoice') {
    const total = patch.total_amount != null ? patch.total_amount : money(before.data.total_amount);
    const paid = patch.amount_paid != null ? patch.amount_paid : money(before.data.amount_paid);
    if (paid > total) {
      return json(400, {
        error: 'That would show $' + paid.toFixed(2) + ' paid on a $' +
               total.toFixed(2) + ' invoice.',
      });
    }
    // Keep the status honest with the money unless he set it himself.
    if (patch.status == null && (patch.total_amount != null || patch.amount_paid != null)) {
      patch.status = paid >= total && total > 0 ? 'paid'
                   : paid > 0 ? 'partially_paid'
                   : (before.data.status === 'paid' || before.data.status === 'partially_paid'
                      ? 'approved' : before.data.status);
    }
  }

  patch.updated_at = new Date().toISOString();

  const up = await supabase.from(table).update(patch)
    .eq(idCol, id).eq('store_id', store_id)
    .select('*').single();
  if (up.error) return json(500, { error: up.error.message });

  const changed = Object.keys(patch).filter((k) => k !== 'updated_at').map((k) =>
    k + ': ' + JSON.stringify(before.data[k]) + ' → ' + JSON.stringify(patch[k]));

  await noted(store_id, 'manual_edit',
    kind + ' corrected by hand — ' + changed.join(', '),
    kind, id, who);

  return json(200, {
    success: true,
    kind: kind,
    id: id,
    changed: changed,
    refused: refused,
    row: up.data,
    says: changed.length + ' field' + (changed.length > 1 ? 's' : '') + ' changed.',
  });
}

// ---------------------------------------------------------------------
// Already paid, but not through here

async function settle(store_id, body, who) {
  const ids = await invoicesToSettle(store_id, body);
  if (ids.error) return json(ids.status, { error: ids.error });
  if (!ids.rows.length) {
    return json(200, { success: true, settled: 0, says: 'Nothing was left owing.' });
  }

  const note = String(body.note || '').trim() ||
    'Marked already paid — settled outside this system';

  const done = [];
  for (const inv of ids.rows) {
    const total = money(inv.total_amount);
    const up = await supabase.from('invoices').update({
      // The balance is generated from total minus paid, so paying it in
      // full is the same as setting paid to the total. Never touch
      // balance_due itself; Postgres refuses it.
      amount_paid: total,
      status: 'paid',
      notes: (inv.notes ? inv.notes + ' | ' : '') + note,
      updated_at: new Date().toISOString(),
    }).eq('invoice_id', inv.invoice_id).eq('store_id', store_id);
    if (up.error) continue;
    done.push({
      invoice_id: inv.invoice_id,
      number: inv.invoice_number,
      cleared: money(inv.balance_due),
    });
  }

  const cleared = money(done.reduce((s, d) => s + d.cleared, 0));

  await noted(store_id, 'marked_already_paid',
    done.length + ' invoice(s) worth $' + cleared.toFixed(2) +
    ' marked already paid outside this system. ' + note,
    'vendor', body.vendor_id, who);

  return json(200, {
    success: true,
    settled: done.length,
    cleared: cleared,
    invoices: done,
    // Said plainly, because this is the one action that can look like money
    // moving when no money moved.
    says: done.length + ' invoice' + (done.length > 1 ? 's' : '') +
          ' cleared, $' + cleared.toFixed(2) + ' off what you owe. No payment ' +
          'was recorded, because this money did not leave through this system.',
  });
}

async function unsettle(store_id, body, who) {
  const ids = (body.invoice_ids || []).filter(isUuid);
  if (!ids.length) return json(400, { error: 'Which invoices?' });

  const res = await supabase.from('invoices')
    .select('invoice_id, invoice_number, total_amount, amount_paid, notes')
    .eq('store_id', store_id).in('invoice_id', ids);
  const rows = res.data || [];
  if (!rows.length) return json(404, { error: 'None of those are on your books.' });

  // Only the part no payment accounts for can be taken back. Undoing a
  // real payment is voiding that payment, not editing the invoice.
  const alloc = await allocationsFor(rows.map((r) => r.invoice_id));

  const done = [];
  for (const inv of rows) {
    const keep = money(alloc[inv.invoice_id] || 0);
    if (money(inv.amount_paid) <= keep) continue;
    const up = await supabase.from('invoices').update({
      amount_paid: keep,
      status: keep > 0 ? 'partially_paid' : 'approved',
      notes: (inv.notes || '').replace(
        /\s*\|?\s*Marked already paid[^|]*/g, '').trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('invoice_id', inv.invoice_id).eq('store_id', store_id);
    if (up.error) continue;
    done.push({ invoice_id: inv.invoice_id, number: inv.invoice_number,
                back_to_owing: money(money(inv.total_amount) - keep) });
  }

  await noted(store_id, 'unmarked_already_paid',
    done.length + ' invoice(s) put back to owing', 'vendor', body.vendor_id, who);

  return json(200, {
    success: true,
    unsettled: done.length,
    invoices: done,
    says: done.length + ' put back to owing.',
  });
}

// Which invoices a settle applies to: the ones named, or every open one on
// a vendor when he asks for all of them.
async function invoicesToSettle(store_id, body) {
  const named = (body.invoice_ids || []).filter(isUuid);

  if (named.length) {
    const r = await supabase.from('invoices')
      .select('invoice_id, invoice_number, total_amount, amount_paid, balance_due, notes, status')
      .eq('store_id', store_id).in('invoice_id', named).neq('status', 'void');
    const rows = (r.data || []).filter((i) => money(i.balance_due) > 0);
    if (!r.data || !r.data.length) {
      return { error: 'None of those are on your books.', status: 404, rows: [] };
    }
    return { rows: rows };
  }

  if (body.all_open) {
    if (!isUuid(body.vendor_id)) return { error: 'Which vendor?', status: 400, rows: [] };
    const r = await supabase.from('invoices')
      .select('invoice_id, invoice_number, total_amount, amount_paid, balance_due, notes, status')
      .eq('store_id', store_id).eq('vendor_id', body.vendor_id).neq('status', 'void');
    return { rows: (r.data || []).filter((i) => money(i.balance_due) > 0) };
  }

  return { error: 'Which invoices? Name them, or ask for all_open on a vendor.',
           status: 400, rows: [] };
}

// ---------------------------------------------------------------------
// Paying it now, from here

async function payNow(store_id, body, who) {
  const vendor = await loadVendor(store_id, body.vendor_id);
  if (!vendor) return json(404, { error: 'Pick a vendor first.' });

  const ids = await invoicesToSettle(store_id, body);
  if (ids.error) return json(ids.status, { error: ids.error });
  if (!ids.rows.length) {
    return json(200, { success: true, paid: 0, says: 'Nothing was left owing.' });
  }

  const amount = money(ids.rows.reduce((s, i) => s + money(i.balance_due), 0));

  return await addPayment(store_id, {
    vendor_id: vendor.vendor_id,
    method: body.method,
    payment_date: body.payment_date,
    amount: amount,
    check_number: body.check_number,
    memo: body.memo || ('Paying ' + ids.rows.length + ' invoice' +
      (ids.rows.length > 1 ? 's' : '')),
    invoice_ids: ids.rows.map((i) => i.invoice_id),
    status: body.status,
  }, who);
}


// Takes back what a line did, before it is marked void.
//
// A voided PAYMENT: whatever it was put against comes back to owing, and
// the allocations go, because money that never left cannot be sitting on
// a bill.
//
// A voided INVOICE: the money really did leave the bank, so the payment
// stands -- but it is no longer against this bill, so the allocations go
// and the payment shows as not applied to anything. That is the honest
// reading: a check he wrote, against a bill that turned out not to exist.
async function unwind(store_id, kind, id) {
  const col = kind === 'payment' ? 'payment_id' : 'invoice_id';
  const allocRes = await supabase.from('payment_allocations')
    .select('allocation_id, payment_id, invoice_id, amount').eq(col, id);
  const allocs = allocRes.data || [];
  if (!allocs.length) return { restored: 0, invoices: 0 };

  const touched = {};
  allocs.forEach((a) => {
    touched[a.invoice_id] = money((touched[a.invoice_id] || 0) + money(a.amount));
  });

  const ids = Object.keys(touched);
  const invRes = await supabase.from('invoices')
    .select('invoice_id, total_amount, amount_paid, status')
    .eq('store_id', store_id).in('invoice_id', ids);

  let restored = 0;
  for (const inv of (invRes.data || [])) {
    const back = touched[inv.invoice_id] || 0;
    // Never below nothing, however the figures got where they are.
    const nowPaid = Math.max(0, money(money(inv.amount_paid) - back));
    const total = money(inv.total_amount);
    const up = await supabase.from('invoices').update({
      amount_paid: nowPaid,
      // Only rewrite the status if this invoice is not itself void.
      status: inv.status === 'void' ? 'void'
            : nowPaid >= total && total > 0 ? 'paid'
            : nowPaid > 0 ? 'partially_paid'
            : 'approved',
      updated_at: new Date().toISOString(),
    }).eq('invoice_id', inv.invoice_id).eq('store_id', store_id);
    if (up.error) continue;
    restored = money(restored + money(money(inv.amount_paid) - nowPaid));
  }

  await supabase.from('payment_allocations')
    .delete().in('allocation_id', allocs.map((a) => a.allocation_id));

  return { restored: restored, invoices: ids.length };
}

// ---------------------------------------------------------------------
// Voiding a line

async function voidLine(store_id, body, who) {
  const kind = body.kind === 'payment' ? 'payment' : 'invoice';
  if (!isUuid(body.id)) return json(400, { error: 'Which line?' });

  const table = kind === 'invoice' ? 'invoices' : 'payments';
  const idCol = kind === 'invoice' ? 'invoice_id' : 'payment_id';
  const reason = String(body.note || '').trim() || 'Voided by hand';

  // Voiding has to put back what the line did, or the ledger keeps the
  // effect of something it says never happened.
  //
  // Found live: a $2,242.87 check was voided and $964.37 of it stayed
  // allocated to the bill. The payment read VOID and the invoice read
  // PAID, at the same time, on the same screen. Void a check on a real
  // invoice and he would have stopped chasing money he still owed.
  const undone = await unwind(store_id, kind, body.id);

  const patch = kind === 'invoice'
    ? { status: 'void', notes: reason, updated_at: new Date().toISOString() }
    : { status: 'void', void_reason: reason, updated_at: new Date().toISOString() };

  const up = await supabase.from(table).update(patch)
    .eq(idCol, body.id).eq('store_id', store_id).select('*').single();
  if (up.error) return json(500, { error: up.error.message });

  await noted(store_id, 'manual_void',
    kind + ' voided — ' + reason +
    (undone.restored ? '. $' + undone.restored.toFixed(2) + ' put back on ' +
      undone.invoices + ' invoice(s)' : ''),
    kind, body.id, who);

  return json(200, {
    success: true, kind: kind, id: body.id,
    put_back: undone.restored,
    invoices_reopened: undone.invoices,
    says: 'Voided. It stays on the ledger marked void and counts nothing.' +
      (undone.restored
        ? ' $' + undone.restored.toFixed(2) + ' is owed again on ' +
          undone.invoices + ' invoice' + (undone.invoices > 1 ? 's' : '') + '.'
        : ''),
  });
}

// ---------------------------------------------------------------------
// A sheet

async function importSheet(store_id, body, who) {
  const read = readVendorSheet(body.sheet || '');
  if (!read.ok) {
    return json(400, { error: read.error, first_rows: read.first_rows || null });
  }

  // Who each line belongs to. One vendor for the whole sheet when he picked
  // one; otherwise the sheet's own vendor column, matched by name and by
  // the spellings on the paper.
  const forced = isUuid(body.vendor_id) ? await loadVendor(store_id, body.vendor_id) : null;
  if (body.vendor_id && !forced) return json(404, { error: 'No such vendor.' });

  let byName = {};
  if (!forced) {
    const [vends, aliases] = await Promise.all([
      supabase.from('vendors').select('vendor_id, name, payment_type, terms_code, terms_days')
        .eq('store_id', store_id),
      supabase.from('vendor_aliases').select('vendor_id, alias_text'),
    ]);
    const byId = {};
    (vends.data || []).forEach((v) => {
      byId[v.vendor_id] = v;
      byName[v.name.toLowerCase().trim()] = v;
    });
    (aliases.data || []).forEach((a) => {
      const v = byId[a.vendor_id];
      if (v) byName[String(a.alias_text).toLowerCase().trim()] = v;
    });
  }

  // What is already on the books, so a sheet imported twice does not double
  // what he owes. Matched on vendor plus invoice number, which is how a
  // vendor identifies a bill when they telephone.
  const existing = {};
  const have = await supabase.from('invoices')
    .select('invoice_id, vendor_id, invoice_number, total_amount, invoice_date, status, balance_due')
    .eq('store_id', store_id).neq('status', 'void');
  (have.data || []).forEach((i) => {
    if (i.invoice_number) {
      existing[i.vendor_id + '|' + String(i.invoice_number).toLowerCase().trim()] = i;
    }
  });

  const plan = [];
  const problems = read.unreadable.slice();

  read.lines.forEach((l) => {
    const vendor = forced ||
      (l.vendor_name ? byName[String(l.vendor_name).toLowerCase().trim()] : null);

    if (!vendor) {
      problems.push({
        row: l.row,
        why: l.vendor_name
          ? 'no vendor on file called "' + l.vendor_name + '"'
          : 'no vendor named on the row, and none chosen for the sheet',
        cells: [l.date, l.number, String(l.amount)],
      });
      return;
    }

    const key = vendor.vendor_id + '|' + String(l.number || '').toLowerCase().trim();
    const already = l.number ? existing[key] : null;

    plan.push({
      row: l.row,
      kind: l.kind,
      vendor_id: vendor.vendor_id,
      vendor_name: vendor.name,
      date: l.date,
      number: l.number,
      amount: l.amount,
      due_date: l.due_date || (l.kind === 'invoice' ? dueFrom(l.date, vendor) : null),
      memo: l.memo,
      already_paid: !!l.already_paid,
      // Flagged, not dropped: he decides whether a bill already on the
      // books is the same bill.
      duplicate_of: already ? already.invoice_id : null,
      duplicate_note: already
        ? 'already on the books, $' + money(already.total_amount).toFixed(2) +
          ' dated ' + already.invoice_date
        : null,
      action: already ? 'skip' : 'add',
    });
  });

  const willAdd = plan.filter((p) => p.action === 'add');
  const invoices = willAdd.filter((p) => p.kind === 'invoice');
  const payments = willAdd.filter((p) => p.kind === 'payment');
  const settleThese = body.settle_already_paid !== false
    ? invoices.filter((p) => p.already_paid) : [];

  const summary = {
    shape: read.shape,
    columns: read.columns,
    header_row: read.header_row,
    read: read.lines.length,
    to_add: willAdd.length,
    invoices: invoices.length,
    invoices_total: money(invoices.reduce((s, p) => s + p.amount, 0)),
    payments: payments.length,
    payments_total: money(payments.reduce((s, p) => s + p.amount, 0)),
    will_be_marked_paid: settleThese.length,
    will_be_marked_paid_total: money(settleThese.reduce((s, p) => s + p.amount, 0)),
    duplicates: plan.filter((p) => p.duplicate_of).length,
    problems: problems.length,
    skipped: read.skipped.length,
    // What he will owe more, once this is in. The figure to check against
    // the sheet's own total before pressing the button.
    adds_to_what_you_owe: money(
      invoices.filter((p) => !p.already_paid).reduce((s, p) => s + p.amount, 0)
      - payments.reduce((s, p) => s + p.amount, 0)),
  };

  // A preview writes nothing. This is the whole point of it: he sees the
  // numbers, checks them against the sheet in front of him, and only then
  // is anything entered.
  if (body.preview !== false) {
    return json(200, {
      preview: true,
      summary: summary,
      plan: plan.slice(0, 300),
      plan_truncated: plan.length > 300,
      problems: problems.slice(0, 100),
      skipped: read.skipped.slice(0, 50),
      says: summary.to_add + ' line' + (summary.to_add === 1 ? '' : 's') +
            ' ready to import. Nothing has been saved yet.',
    });
  }

  // ---- and now for real ----
  const added = { invoices: [], payments: [] };
  const failed = [];

  for (const p of plan) {
    if (p.action !== 'add') continue;
    try {
      if (p.kind === 'invoice') {
        const ins = await supabase.from('invoices').insert({
          store_id: store_id,
          vendor_id: p.vendor_id,
          invoice_number: p.number,
          invoice_date: p.date,
          received_date: p.date,
          due_date: p.due_date,
          total_amount: p.amount,
          // Straight in as paid when the sheet said so, which is the
          // "all paid already" case arriving from a spreadsheet instead of
          // from the button.
          amount_paid: (p.already_paid && body.settle_already_paid !== false) ? p.amount : 0,
          status: (p.already_paid && body.settle_already_paid !== false) ? 'paid' : 'approved',
          notes: 'Imported from a sheet' + (p.memo ? ' — ' + p.memo : '') +
                 ((p.already_paid && body.settle_already_paid !== false)
                   ? ' | Marked already paid — settled outside this system' : ''),
        }).select('invoice_id').single();
        if (ins.error) throw new Error(ins.error.message);
        added.invoices.push({ row: p.row, invoice_id: ins.data.invoice_id, number: p.number });
      } else {
        const ins = await supabase.from('payments').insert({
          store_id: store_id,
          vendor_id: p.vendor_id,
          method: 'check',
          payment_date: p.date,
          amount: p.amount,
          check_number: /^\d+$/.test(String(p.number || '')) ? Number(p.number) : null,
          memo: 'Imported from a sheet' + (p.memo ? ' — ' + p.memo : ''),
          // Imported history has already been through the bank. Calling it
          // outstanding would put old checks on the checks-still-out list
          // and make him chase cheques that cleared months ago.
          status: 'cleared',
          cleared_date: p.date,
        }).select('payment_id').single();
        if (ins.error) throw new Error(ins.error.message);
        added.payments.push({ row: p.row, payment_id: ins.data.payment_id });
      }
    } catch (e) {
      failed.push({ row: p.row, why: e.message });
    }
  }

  await noted(store_id, 'sheet_import',
    'Imported ' + added.invoices.length + ' invoice(s) and ' +
    added.payments.length + ' payment(s) from a ' + read.shape + '. ' +
    summary.will_be_marked_paid + ' marked already paid. ' +
    failed.length + ' failed, ' + problems.length + ' could not be read.',
    'vendor', body.vendor_id, who);

  return json(200, {
    preview: false,
    success: true,
    summary: summary,
    added_invoices: added.invoices.length,
    added_payments: added.payments.length,
    marked_paid: summary.will_be_marked_paid,
    failed: failed,
    problems: problems.slice(0, 100),
    says: added.invoices.length + ' invoice' + (added.invoices.length === 1 ? '' : 's') +
          ' and ' + added.payments.length + ' payment' + (added.payments.length === 1 ? '' : 's') +
          ' imported' +
          (summary.will_be_marked_paid
            ? ', ' + summary.will_be_marked_paid + ' of them already paid' : '') +
          (failed.length ? '. ' + failed.length + ' would not save' : '') +
          (problems.length ? '. ' + problems.length + ' could not be read' : '') + '.',
  });
}

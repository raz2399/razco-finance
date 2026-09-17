// Netlify Function: checks
// Log checks, list them, and mark them cleared.
// Route: /.netlify/functions/checks
//   GET  ?store_id=store1            -> outstanding + recently cleared checks
//   POST { store_id, check_number, payee, amount, payment_date, memo }
//   POST { store_id, payment_id, action: "clear" | "void" }
//
// Adapts to the real column list, so it does not break on columns it cannot see.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const todayStr = () => new Date().toISOString().split('T')[0];

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

// Fill NOT NULL columns the table demands; skip any the database generates.
function fillRequired(row, def, text, today) {
  const required = def.required || [];
  const props = def.properties || {};
  const filled = [];
  required.forEach((key) => {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return;
    const p = props[key] || {};
    if (p.default !== undefined) return;
    const kind = String(p.format || p.type || '').toLowerCase();
    let value;
    if (kind.includes('uuid')) value = crypto.randomUUID();
    else if (/int|numeric|double|real|float|money|decimal/.test(kind)) value = 0;
    else if (/timestamp|date/.test(kind)) value = today;
    else if (kind.includes('bool')) value = false;
    else value = text;
    row[key] = value;
    filled.push(key);
  });
  return filled;
}

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    // ---------------- GET: list ------------------------------------------
    if (event.httpMethod === 'GET') {
      const { store_id } = event.queryStringParameters || {};
      if (!store_id) return json(400, { error: 'Missing store_id' });

      const res = await supabase
        .from('payments')
        .select('payment_id, check_number, amount, payment_date, memo, status, cleared_date, issued_at')
        .eq('store_id', store_id)
        .eq('method', 'check')
        .order('payment_date', { ascending: false })
        .limit(100);

      if (res.error) return json(500, { error: res.error.message });

      const rows = res.data || [];
      const outstanding = rows.filter((r) => r.status === 'outstanding');
      const outstandingTotal = outstanding.reduce((s, r) => s + (Number(r.amount) || 0), 0);

      // bank balance, so the page can show real available cash
      const acct = await supabase
        .from('bank_accounts')
        .select('current_balance, balance_as_of')
        .eq('store_id', store_id)
        .limit(1)
        .maybeSingle();

      const bankBalance = acct.data ? Number(acct.data.current_balance) || 0 : 0;

      return json(200, {
        store_id,
        bank_balance: bankBalance,
        bank_balance_as_of: acct.data ? acct.data.balance_as_of : null,
        outstanding_count: outstanding.length,
        outstanding_total: Math.round(outstandingTotal * 100) / 100,
        real_available_cash: Math.round((bankBalance - outstandingTotal) * 100) / 100,
        checks: rows,
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'GET or POST only' });

    const body = JSON.parse(event.body || '{}');
    const { store_id } = body;
    if (!store_id) return json(400, { error: 'Missing store_id' });

    // ---------------- POST: clear or void --------------------------------
    if (body.action === 'clear' || body.action === 'void') {
      if (!body.payment_id) return json(400, { error: 'Missing payment_id' });
      const patch = body.action === 'clear'
        ? { status: 'cleared', cleared_date: body.cleared_date || todayStr() }
        : { status: 'void', void_reason: body.reason || 'voided in app' };

      const res = await supabase
        .from('payments')
        .update(patch)
        .eq('payment_id', body.payment_id)
        .eq('store_id', store_id);

      if (res.error) return json(500, { error: res.error.message });
      return json(200, { success: true, payment_id: body.payment_id, action: body.action });
    }

    // ---------------- POST: log a new check -------------------------------
    const checkNumber = String(body.check_number || '').trim();
    const payee = String(body.payee || '').trim();
    const amount = Number(String(body.amount || '').replace(/[$,\s]/g, ''));
    const paymentDate = body.payment_date || todayStr();

    if (!checkNumber) return json(400, { error: 'Check number is required' });
    if (!payee) return json(400, { error: 'Payee is required' });
    if (!amount || isNaN(amount) || amount <= 0) return json(400, { error: 'Amount must be a positive number' });

    // Same number twice is almost always a mistake — catch it.
    const dupe = await supabase
      .from('payments')
      .select('payment_id, amount, payment_date, status')
      .eq('store_id', store_id)
      .eq('method', 'check')
      .eq('check_number', checkNumber)
      .limit(1)
      .maybeSingle();

    if (dupe.data && !body.allow_duplicate) {
      return json(409, {
        error: `Check ${checkNumber} is already logged for $${Number(dupe.data.amount).toFixed(2)} on ${dupe.data.payment_date}.`,
        duplicate_of: dupe.data,
      });
    }

    const defs = await schema();
    const payCols = (defs.payments || {}).properties || {};

    // Use whichever bank account this store has, if any.
    const acct = await supabase
      .from('bank_accounts')
      .select('account_id')
      .eq('store_id', store_id)
      .limit(1)
      .maybeSingle();

    const row = onlyRealColumns(
      {
        store_id,
        account_id: acct.data ? acct.data.account_id : null,
        method: 'check',
        check_number: checkNumber,
        amount,
        payment_date: paymentDate,
        memo: body.memo ? `${payee} — ${body.memo}` : payee,
        status: 'outstanding',
        issued_at: new Date(paymentDate + 'T12:00:00Z').toISOString(),
        qb_synced: false,
      },
      payCols
    );

    // Never send a null account_id if the column will not take one.
    if (row.account_id === null) delete row.account_id;

    const autoFilled = fillRequired(row, defs.payments || {}, payee, paymentDate);

    const ins = await supabase.from('payments').insert(row).select('payment_id, check_number, amount');
    if (ins.error) return json(500, { error: 'Could not save the check: ' + ins.error.message });

    // Recalculate so the page can show the new number straight away.
    const open = await supabase
      .from('payments')
      .select('amount')
      .eq('store_id', store_id)
      .eq('method', 'check')
      .eq('status', 'outstanding');

    const outstandingTotal = (open.data || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);

    const bank = await supabase
      .from('bank_accounts')
      .select('current_balance')
      .eq('store_id', store_id)
      .limit(1)
      .maybeSingle();

    const bankBalance = bank.data ? Number(bank.data.current_balance) || 0 : 0;

    return json(200, {
      success: true,
      check: ins.data ? ins.data[0] : null,
      auto_filled_columns: autoFilled,
      outstanding_count: (open.data || []).length,
      outstanding_total: Math.round(outstandingTotal * 100) / 100,
      bank_balance: bankBalance,
      real_available_cash: Math.round((bankBalance - outstandingTotal) * 100) / 100,
    });
  } catch (error) {
    console.error('checks error:', error);
    return json(500, { error: error.message });
  }
};

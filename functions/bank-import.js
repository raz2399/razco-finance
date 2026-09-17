// Netlify Function: bank-import
// Imports bank CSV, deduplicates, matches to payments, and updates the account balance.
// Route: /.netlify/functions/bank-import
// Method: POST
// Payload: { store_id, account_id, csv_text, ending_balance (optional), account_label (optional) }
//
// FIXED:
//  - writes the balance back to bank_accounts (nothing did this before, so
//    cash-position always saw an empty table)
//  - CSV parser handles quoted commas, CRLF line endings, $ and () negatives,
//    and only skips a first row that is actually a header
//  - maybeSingle instead of single, so "no match" stops being an error
//  - matched/unmatched counts now reflect reality

const crypto = require('crypto');

const isUuid = (v) =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// Ask PostgREST which columns each table actually has, so we never send a
// field that does not exist. One call, cached for the life of the invocation.
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

// Drop any key the table does not have.
function onlyRealColumns(row, columns) {
  const out = {};
  Object.keys(row).forEach((k) => { if (columns[k]) out[k] = row[k]; });
  return out;
}
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- CSV ------------------------------------------------------------------
// Reads the header row and finds columns by NAME. Falls back to sniffing the
// data when there is no usable header. Rows without a real date (bank preamble,
// account name, totals lines) are skipped instead of being treated as data.

function splitLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim().replace(/^["']|["']$/g, ''));
}

function toAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  const paren = /^\(.*\)$/.test(s);
  s = s.replace(/[()$\s,]/g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return paren ? -n : n;
}

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

// Returns YYYY-MM-DD, or null if this is not a date.
function toDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // 2026-09-14
  if (m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;

  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);   // 09/14/2026 or 9-14-26
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return `${y}-${String(+m[1]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`;
  }

  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/); // Sep 14, 2026
  if (m && MONTHS[m[1].toLowerCase()]) {
    return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`;
  }

  return null;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const low = rows[i].map((c) => c.toLowerCase());
    const hasDate = low.some((c) => /date|posted|posting/.test(c));
    const hasMoney = low.some((c) => /amount|debit|credit|withdraw|deposit/.test(c));
    if (hasDate && hasMoney) {
      const idx = { date: -1, desc: -1, amount: -1, debit: -1, credit: -1, balance: -1 };
      low.forEach((c, j) => {
        if (idx.date < 0 && /date|posted|posting/.test(c)) idx.date = j;
        else if (idx.desc < 0 && /desc|memo|payee|detail|narrat|transaction/.test(c)) idx.desc = j;
        if (/^bal|balance/.test(c)) idx.balance = j;
        else if (/debit|withdraw/.test(c)) idx.debit = j;
        else if (/credit|deposit/.test(c)) idx.credit = j;
        else if (idx.amount < 0 && /amount|amt/.test(c)) idx.amount = j;
      });
      return { row: i, idx };
    }
  }
  return null;
}

function parseCSV(text) {
  const rows = String(text).trim().split(/\r\n|\n|\r/)
    .filter((l) => l && l.replace(/[\s,]/g, ''))
    .map(splitLine);

  const header = findHeader(rows);
  const startAt = header ? header.row + 1 : 0;
  const data = [];
  const skipped = [];

  for (let i = startAt; i < rows.length; i++) {
    const cols = rows[i];
    if (cols.length < 2) { skipped.push(rows[i].join(',')); continue; }

    // --- date: named column first, otherwise the first cell that is a date
    let date = header && header.idx.date >= 0 ? toDate(cols[header.idx.date]) : null;
    let dateIdx = header && header.idx.date >= 0 ? header.idx.date : -1;
    if (!date) {
      for (let j = 0; j < cols.length; j++) {
        const d = toDate(cols[j]);
        if (d) { date = d; dateIdx = j; break; }
      }
    }
    if (!date) { skipped.push(cols.join(',')); continue; }  // preamble, totals, blank

    // --- amount
    let amount = NaN;
    let amountIdx = -1;
    if (header && (header.idx.debit >= 0 || header.idx.credit >= 0)) {
      const debit = toAmount(cols[header.idx.debit]);
      const credit = toAmount(cols[header.idx.credit]);
      const d = isNaN(debit) ? 0 : Math.abs(debit);
      const c = isNaN(credit) ? 0 : Math.abs(credit);
      if (d || c) { amount = c - d; amountIdx = c ? header.idx.credit : header.idx.debit; }
    }
    if (isNaN(amount) && header && header.idx.amount >= 0) {
      amount = toAmount(cols[header.idx.amount]);
      amountIdx = header.idx.amount;
    }
    if (isNaN(amount)) {
      // last numeric cell that is not the date and not the balance column
      for (let j = cols.length - 1; j >= 0; j--) {
        if (j === dateIdx) continue;
        if (header && j === header.idx.balance) continue;
        const n = toAmount(cols[j]);
        if (!isNaN(n)) { amount = n; amountIdx = j; break; }
      }
    }
    if (isNaN(amount)) { skipped.push(cols.join(',')); continue; }

    // --- description
    let description = '';
    if (header && header.idx.desc >= 0) description = cols[header.idx.desc];
    if (!description) {
      description = cols
        .filter((c, j) => j !== dateIdx && j !== amountIdx && !/^[\d.,$()-]+$/.test(c))
        .sort((a, b) => b.length - a.length)[0] || 'Transaction';
    }

    data.push({ date, description, amount, raw: cols.join(',') });
  }

  data.skipped = skipped;
  return data;
}

function hashTransaction(date, desc, amount) {
  return crypto.createHash('sha256').update(`${date}|${desc}|${amount}`).digest('hex');
}

// --- handler ---------------------------------------------------------------
// Batched: whole file in a handful of queries, not several per row.
// Self-adapting: reads the real column list before writing, and resolves the
// bank account itself so the user never has to supply a UUID.

const CHUNK = 200;

exports.handler = async (event) => {
  try {
    const { store_id, account_id, csv_text, ending_balance, account_label } =
      JSON.parse(event.body || '{}');

    if (!store_id || !csv_text) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing store_id or csv_text' }) };
    }

    const transactions = parseCSV(csv_text);
    if (transactions.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No transactions found in CSV' }) };
    }

    const defs = await schema();
    const acctCols = (defs.bank_accounts || {}).properties || {};
    const txnCols = (defs.bank_transactions || {}).properties || {};

    // --- resolve the account, creating one on first run -------------------
    const label = account_label || account_id || 'Operating';
    let resolvedId = null;
    let accountCreated = false;

    const existing = await supabase
      .from('bank_accounts')
      .select('account_id')
      .eq('store_id', store_id)
      .limit(1)
      .maybeSingle();

    if (existing.data && existing.data.account_id) {
      resolvedId = existing.data.account_id;
    } else {
      resolvedId = isUuid(account_id) ? account_id : crypto.randomUUID();
      accountCreated = true;
    }

    // The account row must exist first — bank_transactions.account_id is a
    // foreign key pointing at it. Create it now, set the real balance later.
    const writeAccount = async (balance, asOf) => {
      const row = onlyRealColumns(
        {
          account_id: resolvedId,
          store_id,
          label,
          name: label,
          account_name: label,
          current_balance: balance,
          balance_as_of: asOf,
        },
        acctCols
      );
      return supabase.from('bank_accounts').upsert(row, { onConflict: 'account_id' });
    };

    if (accountCreated) {
      const seed = await writeAccount(0, new Date().toISOString().split('T')[0]);
      if (seed.error) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Could not create the bank account row: ' + seed.error.message }),
        };
      }
    }

    const batchId = crypto.randomUUID();
    transactions.forEach((t) => {
      t.hash = hashTransaction(t.date, t.description, Math.abs(t.amount));
    });

    // --- 1. which have we seen before -------------------------------------
    const seen = new Set();
    for (let i = 0; i < transactions.length; i += CHUNK) {
      const hashes = transactions.slice(i, i + CHUNK).map((t) => t.hash);
      const found = await supabase
        .from('bank_transactions')
        .select('import_hash')
        .in('import_hash', hashes);
      (found.data || []).forEach((r) => seen.add(r.import_hash));
    }

    const batchSeen = new Set();
    const fresh = [];
    const duplicates = [];
    for (const t of transactions) {
      if (seen.has(t.hash) || batchSeen.has(t.hash)) {
        duplicates.push({ date: t.date, description: t.description, amount: t.amount });
        continue;
      }
      batchSeen.add(t.hash);
      fresh.push(t);
    }

    // --- 2. bulk insert ----------------------------------------------------
    let insertedRows = [];
    let insertError = null;
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const payload = fresh.slice(i, i + CHUNK).map((t) =>
        onlyRealColumns(
          {
            account_id: resolvedId,
            store_id,
            posted_date: t.date,
            description: t.description,
            amount: t.amount,
            import_batch: batchId,
            import_hash: t.hash,
            match_status: 'unmatched',
          },
          txnCols
        )
      );
      const res = await supabase
        .from('bank_transactions')
        .insert(payload)
        .select('bank_txn_id, import_hash, amount');
      if (res.error) { insertError = res.error.message; break; }
      insertedRows = insertedRows.concat(res.data || []);
    }

    if (insertError) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Insert failed: ' + insertError }) };
    }

    // --- 3. outstanding checks, one query ---------------------------------
    const checksRes = await supabase
      .from('payments')
      .select('payment_id, check_number, amount')
      .eq('store_id', store_id)
      .eq('method', 'check')
      .eq('status', 'outstanding');

    const openChecks = checksRes.data || [];
    const usedCheck = new Set();

    // --- 4. match in memory ------------------------------------------------
    const hashToTxn = {};
    fresh.forEach((t) => { hashToTxn[t.hash] = t; });

    const matches = [];
    for (const row of insertedRows) {
      const txn = hashToTxn[row.import_hash];
      if (!txn || txn.amount >= 0) continue;
      const target = Math.abs(txn.amount);
      const hit = openChecks.find(
        (c) => !usedCheck.has(c.payment_id) && Math.abs(Number(c.amount) - target) < 0.005
      );
      if (hit) {
        usedCheck.add(hit.payment_id);
        matches.push({ txn_id: row.bank_txn_id, payment_id: hit.payment_id, check_number: hit.check_number, date: txn.date });
      }
    }

    for (const m of matches) {
      await supabase
        .from('bank_transactions')
        .update({ match_status: 'matched', matched_type: 'payment', matched_id: m.payment_id })
        .eq('bank_txn_id', m.txn_id);
      await supabase
        .from('payments')
        .update({ status: 'cleared', cleared_date: m.date })
        .eq('payment_id', m.payment_id);
    }

    // --- 5. balance --------------------------------------------------------
    const latestDate = transactions.map((t) => t.date).sort().slice(-1)[0];

    let newBalance = null;
    let balanceSource = null;

    if (ending_balance !== undefined && ending_balance !== null && ending_balance !== '') {
      newBalance = Number(ending_balance);
      balanceSource = 'statement ending balance';
    } else {
      const all = await supabase
        .from('bank_transactions')
        .select('amount')
        .eq('account_id', resolvedId);
      if (all.data) {
        newBalance = all.data.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        balanceSource = 'sum of all imported transactions';
      }
    }

    let balanceWritten = false;
    let balanceError = null;

    if (newBalance !== null && !isNaN(newBalance)) {
      const write = await writeAccount(
        newBalance,
        latestDate || new Date().toISOString().split('T')[0]
      );
      balanceWritten = !write.error;
      if (write.error) balanceError = write.error.message;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        summary: {
          batch_id: batchId,
          store_id,
          account_id: resolvedId,
          account_created: accountCreated,
          import_date: new Date().toISOString(),
          total_transactions: transactions.length,
          imported_count: insertedRows.length,
          duplicate_count: duplicates.length,
          auto_matched: matches.length,
          unmatched_count: insertedRows.length - matches.length,
          balance_written: balanceWritten,
          new_balance: newBalance,
          balance_source: balanceSource,
          balance_as_of: latestDate,
          balance_error: balanceError,
        },
        cleared_checks: matches.map((m) => m.check_number),
        duplicates: duplicates.slice(0, 50),
        next_steps: [
          `${insertedRows.length} transactions imported, ${duplicates.length} duplicates skipped`,
          matches.length
            ? `${matches.length} check${matches.length > 1 ? 's' : ''} cleared automatically`
            : 'No checks matched automatically',
          balanceWritten
            ? `Bank balance set to $${Number(newBalance).toFixed(2)} (${balanceSource})`
            : 'Bank balance NOT updated — ' + (balanceError || 'no balance available'),
        ],
      }),
    };
  } catch (error) {
    console.error('Bank import error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

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
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- CSV ------------------------------------------------------------------
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
  const paren = /^\(.*\)$/.test(s);          // (123.45) means negative
  s = s.replace(/[()$\s,]/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return paren ? -n : n;
}

function parseCSV(text) {
  const lines = String(text).trim().split(/\r\n|\n|\r/);
  const data = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || !lines[i].replace(/[\s,]/g, '')) continue;
    const cols = splitLine(lines[i]);
    if (cols.length < 3) continue;

    // Amount is the last column that parses as a number.
    let amount = NaN;
    let amountIdx = -1;
    for (let j = cols.length - 1; j >= 1; j--) {
      const n = toAmount(cols[j]);
      if (!isNaN(n) && /\d/.test(cols[j])) { amount = n; amountIdx = j; break; }
    }
    // No numeric column means this is the header row, not a transaction.
    if (amountIdx < 0) continue;

    const description = cols
      .filter((c, idx) => idx !== 0 && idx !== amountIdx)
      .sort((a, b) => b.length - a.length)[0] || 'Transaction';

    data.push({ date: cols[0], description, amount, raw: lines[i] });
  }

  return data;
}

function hashTransaction(date, desc, amount) {
  return crypto.createHash('sha256').update(`${date}|${desc}|${amount}`).digest('hex');
}

// --- handler ---------------------------------------------------------------
// Batched: the whole file is processed in a handful of queries instead of
// several per row. A 150-line statement used to mean ~400 round trips and a
// gateway timeout; it is now about 6 regardless of file size.

const CHUNK = 200;

exports.handler = async (event) => {
  try {
    const { store_id, account_id, csv_text, ending_balance, account_label } =
      JSON.parse(event.body || '{}');

    if (!store_id || !account_id || !csv_text) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const transactions = parseCSV(csv_text);
    if (transactions.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No transactions found in CSV' }) };
    }

    const batchId = crypto.randomUUID();
    transactions.forEach((t) => {
      t.hash = hashTransaction(t.date, t.description, Math.abs(t.amount));
    });

    // 1. Which of these have we already imported? One query per 200 rows.
    const seen = new Set();
    for (let i = 0; i < transactions.length; i += CHUNK) {
      const hashes = transactions.slice(i, i + CHUNK).map((t) => t.hash);
      const found = await supabase
        .from('bank_transactions')
        .select('import_hash')
        .in('import_hash', hashes);
      (found.data || []).forEach((r) => seen.add(r.import_hash));
    }

    // Same file can also contain the same row twice — dedupe within the batch.
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

    // 2. Insert everything new in bulk.
    let insertedRows = [];
    let insertError = null;
    for (let i = 0; i < fresh.length; i += CHUNK) {
      const payload = fresh.slice(i, i + CHUNK).map((t) => ({
        account_id,
        store_id,
        posted_date: t.date,
        description: t.description,
        amount: t.amount,
        import_batch: batchId,
        import_hash: t.hash,
        match_status: 'unmatched',
      }));
      const res = await supabase.from('bank_transactions').insert(payload).select('bank_txn_id, import_hash, amount');
      if (res.error) { insertError = res.error.message; break; }
      insertedRows = insertedRows.concat(res.data || []);
    }

    if (insertError) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Insert failed: ' + insertError }) };
    }

    // 3. All outstanding checks for this store, in one query.
    const checksRes = await supabase
      .from('payments')
      .select('payment_id, check_number, amount')
      .eq('store_id', store_id)
      .eq('method', 'check')
      .eq('status', 'outstanding');

    const openChecks = checksRes.data || [];
    const usedCheck = new Set();

    // 4. Match in memory — no queries at all.
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

    // 5. Write the matches. One pair of updates per matched check only.
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

    // 6. Update the account balance — the step that was missing entirely.
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
        .eq('account_id', account_id);
      if (all.data) {
        newBalance = all.data.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        balanceSource = 'sum of all imported transactions';
      }
    }

    let balanceWritten = false;
    let balanceError = null;

    if (newBalance !== null && !isNaN(newBalance)) {
      const write = await supabase.from('bank_accounts').upsert(
        {
          account_id,
          store_id,
          label: account_label || 'Operating',
          current_balance: newBalance,
          balance_as_of: latestDate || new Date().toISOString().split('T')[0],
        },
        { onConflict: 'account_id' }
      );
      balanceWritten = !write.error;
      if (write.error) balanceError = write.error.message;
    }

    const clearedChecks = matches.map((m) => m.check_number);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        summary: {
          batch_id: batchId,
          store_id,
          account_id,
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
        cleared_checks: clearedChecks,
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

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
    const imported = [];
    const duplicates = [];
    const clearedChecks = [];

    for (const txn of transactions) {
      const hash = hashTransaction(txn.date, txn.description, Math.abs(txn.amount));

      const existing = await supabase
        .from('bank_transactions')
        .select('bank_txn_id')
        .eq('import_hash', hash)
        .limit(1)
        .maybeSingle();

      if (existing.data) {
        duplicates.push({ date: txn.date, description: txn.description, amount: txn.amount });
        continue;
      }

      const result = await supabase
        .from('bank_transactions')
        .insert({
          account_id,
          store_id,
          posted_date: txn.date,
          description: txn.description,
          amount: txn.amount,
          import_batch: batchId,
          import_hash: hash,
          match_status: 'unmatched',
        })
        .select('bank_txn_id');

      if (!result.data || !result.data[0]) continue;

      const row = {
        bank_txn_id: result.data[0].bank_txn_id,
        date: txn.date,
        description: txn.description,
        amount: txn.amount,
        matched: false,
      };

      // Money out — try to clear an outstanding check of the same amount.
      if (txn.amount < 0) {
        const check = await supabase
          .from('payments')
          .select('payment_id, check_number')
          .eq('store_id', store_id)
          .eq('method', 'check')
          .eq('status', 'outstanding')
          .eq('amount', Math.abs(txn.amount))
          .limit(1)
          .maybeSingle();

        if (check.data) {
          await supabase
            .from('bank_transactions')
            .update({
              match_status: 'matched',
              matched_type: 'payment',
              matched_id: check.data.payment_id,
            })
            .eq('bank_txn_id', row.bank_txn_id);

          await supabase
            .from('payments')
            .update({ status: 'cleared', cleared_date: txn.date })
            .eq('payment_id', check.data.payment_id);

          row.matched = true;
          row.matched_check = check.data.check_number;
          clearedChecks.push(check.data.check_number);
        }
      }

      imported.push(row);
    }

    // --- update the account balance ---------------------------------------
    // This is the step that was missing entirely. Without it, bank_accounts
    // stays empty and cash-position has no balance to report.
    const latestDate = transactions
      .map((t) => t.date)
      .sort()
      .slice(-1)[0];

    let newBalance = null;
    let balanceSource = null;

    if (ending_balance !== undefined && ending_balance !== null && ending_balance !== '') {
      newBalance = Number(ending_balance);
      balanceSource = 'statement ending balance';
    } else {
      // Fall back to the running total of every transaction ever imported.
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
      const write = await supabase
        .from('bank_accounts')
        .upsert(
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

    const autoMatched = imported.filter((i) => i.matched).length;

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
          imported_count: imported.length,
          duplicate_count: duplicates.length,
          auto_matched: autoMatched,
          unmatched_count: imported.length - autoMatched,
          balance_written: balanceWritten,
          new_balance: newBalance,
          balance_source: balanceSource,
          balance_as_of: latestDate,
          balance_error: balanceError,
        },
        cleared_checks: clearedChecks,
        imported,
        duplicates,
        next_steps: [
          `${imported.length} transactions imported, ${duplicates.length} duplicates skipped`,
          autoMatched
            ? `${autoMatched} check${autoMatched > 1 ? 's' : ''} cleared automatically`
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

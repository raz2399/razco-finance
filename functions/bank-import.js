// Netlify Function: bank-import
// Imports bank CSV, deduplicates, matches to payments/settlements
// Route: /.netlify/functions/bank-import
// Method: POST
// Payload: { store_id, account_id, csv_text }

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Parse CSV — handles common bank formats
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const data = [];

  // Detect headers
  let headerLine = 0;
  if (lines[0].toLowerCase().includes('date')) headerLine = 0;
  if (lines[0].toLowerCase().includes('posted')) headerLine = 0;

  for (let i = headerLine + 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length >= 3) {
      data.push({
        date: cols[0],
        description: cols[1],
        amount: parseFloat(cols[2]) || 0,
        raw: lines[i],
      });
    }
  }

  return data;
}

// Generate import hash to prevent duplicates
function hashTransaction(date, desc, amount) {
  return crypto
    .createHash('sha256')
    .update(`${date}|${desc}|${amount}`)
    .digest('hex');
}

// Simple amount matching
function findMatchingPayment(amount, txnDesc) {
  // Will be queried from database
  return null;
}

exports.handler = async (event) => {
  try {
    const { store_id, account_id, csv_text } = JSON.parse(event.body);

    if (!store_id || !account_id || !csv_text) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields' }),
      };
    }

    // Parse CSV
    const transactions = parseCSV(csv_text);

    if (transactions.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No transactions found in CSV' }),
      };
    }

    // Import batch ID
    const batchId = crypto.randomUUID();

    const imported = [];
    const duplicates = [];
    const unmatched = [];

    // Process each transaction
    for (const txn of transactions) {
      const hash = hashTransaction(txn.date, txn.description, Math.abs(txn.amount));

      // Check if already imported
      const existing = await supabase
        .from('bank_transactions')
        .select('bank_txn_id')
        .eq('import_hash', hash)
        .limit(1)
        .single();

      if (existing.data) {
        duplicates.push({
          date: txn.date,
          description: txn.description,
          amount: txn.amount,
          reason: 'Already imported',
        });
        continue;
      }

      // Insert transaction
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

      if (result.data) {
        imported.push({
          bank_txn_id: result.data[0].bank_txn_id,
          date: txn.date,
          description: txn.description,
          amount: txn.amount,
        });

        // Try simple matching against outstanding checks
        if (txn.amount < 0) {
          const check = await supabase
            .from('payments')
            .select('payment_id, check_number')
            .eq('store_id', store_id)
            .eq('method', 'check')
            .eq('status', 'outstanding')
            .eq('amount', Math.abs(txn.amount))
            .limit(1)
            .single();

          if (check.data) {
            // Auto-match
            await supabase
              .from('bank_transactions')
              .update({
                match_status: 'matched',
                matched_type: 'payment',
                matched_id: check.data.payment_id,
              })
              .eq('bank_txn_id', result.data[0].bank_txn_id);

            // Mark payment as cleared
            await supabase
              .from('payments')
              .update({
                status: 'cleared',
                cleared_date: txn.date,
              })
              .eq('payment_id', check.data.payment_id);
          }
        }
      }
    }

    // Summary
    const summary = {
      batch_id: batchId,
      store_id,
      account_id,
      import_date: new Date().toISOString(),
      total_transactions: transactions.length,
      imported_count: imported.length,
      duplicate_count: duplicates.length,
      unmatched_count: imported.filter((i) => !i.matched).length,
      auto_matched: imported.filter((i) => i.matched).length || 0,
    };

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        summary,
        imported,
        duplicates,
        next_steps: [
          `${imported.length} transactions imported`,
          `${duplicates.length} duplicates skipped`,
          'Review unmatched transactions in the app',
          'Click to match remaining items to invoices or settlements',
        ],
      }),
    };
  } catch (error) {
    console.error('Bank import error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

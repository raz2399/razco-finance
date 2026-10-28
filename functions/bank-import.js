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

// The store is in Lindsay, California. Its day ends when the store closes,
// not at 5pm local when UTC rolls into tomorrow -- which is exactly when the
// back office is being worked. Business dates are Pacific; instants
// (created_at and friends) stay UTC, because those are moments, not days.
const BUSINESS_TZ = 'America/Los_Angeles';
const pacificToday = () => new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });


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
// Columns Postgres computes itself; any value sent for one is rejected.
const GENERATED = { balance_due: 1, net_sales: 1 };

function onlyRealColumns(row, columns) {
  const out = {};
  Object.keys(row).forEach((k) => {
    if (columns[k] && !GENERATED[k]) out[k] = row[k];
  });
  return out;
}

// Fill every NOT NULL column the table demands, whatever it happens to be
// called. Stops the import dying one column at a time on schemas we cannot see.
function fillRequired(row, def, text, today) {
  const required = def.required || [];
  const props = def.properties || {};
  const filled = [];

  required.forEach((key) => {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return;
    const p = props[key] || {};

    // The database already fills this one (gen_random_uuid(), now(), nextval...).
    // Sending the default TEXT would be written as a literal string, so leave it out.
    if (p.default !== undefined) return;

    const kind = String(p.format || p.type || '').toLowerCase();
    let value;

    if (kind.includes('uuid')) value = crypto.randomUUID();
    else if (/int|numeric|double|real|float|money|decimal/.test(kind)) value = 0;
    else if (/timestamp|date/.test(kind)) value = today;
    else if (kind.includes('bool')) value = true;
    else value = text;

    row[key] = value;
    filled.push(key);
  });

  return filled;
}
const { createClient } = require('@supabase/supabase-js');


// Banks write a check line a dozen ways: "CHECK 5101", "CHECK# 5101",
// "CK 5101", "Check Paid #5101", or the bare number in its own column.
// Anything that is not clearly a check reference is left alone — a wrong
// number is worse than no number, because it would clear the wrong check.
function checkNumberFrom(description, cols) {
  const text = String(description || '');
  const labelled = text.match(/\b(?:CHECK|CHK|CK)\s*(?:NO\.?|NUM(?:BER)?|#)?\s*0*(\d{2,7})\b/i);
  if (labelled) return Number(labelled[1]);

  // A column holding nothing but a plausible check number, on a line that
  // calls itself a check.
  if (cols && /\bCHECK\b|\bCHK\b/i.test(text)) {
    for (const c of cols) {
      const t = String(c || '').trim();
      if (/^0*\d{2,7}$/.test(t)) return Number(t);
    }
  }
  return null;
}

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

const daysApart = (a, b) =>
  Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);

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

// Which way the money went, from a word. Returns -1 out, 1 in, 0 when the
// cell says nothing we recognise -- and 0 means "leave the amount alone"
// rather than "treat it as money in", because a word we cannot read is not
// permission to guess the direction.
function signFromType(cell) {
  const v = String(cell == null ? '' : cell).trim().toLowerCase();
  if (!v) return 0;
  if (/^(c|cr|credit|deposit|dep|in|received?)\b/.test(v)) return 1;
  if (/^(d|db|dr|debit|withdraw|withdrawal|wd|out|payment|paid|check)\b/.test(v)) return -1;
  return 0;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const low = rows[i].map((c) => c.toLowerCase());
    const hasDate = low.some((c) => /date|posted|posting/.test(c));
    const hasMoney = low.some((c) => /amount|debit|credit|withdraw|deposit/.test(c));
    if (hasDate && hasMoney) {
      const idx = { date: -1, desc: -1, amount: -1, debit: -1, credit: -1,
                    balance: -1, type: -1, check: -1 };
      low.forEach((c, j) => {
        const t = c.trim();
        // A "Credit or Debit" column holds the WORD, not the money. Bank of
        // the Sierra exports one Amount column plus this one to carry the
        // sign. Read before the debit/credit tests below, which are looking
        // for columns that hold amounts: without this, "Credit or Debit"
        // matches /debit/, yields no number, and every debit in the file
        // falls through and loads as money coming in.
        // Naming both words in one header ("Credit or Debit", "Debit/Credit")
        // means the column holds the direction. A column that holds a number
        // is unaffected: signFromType cannot read a number, and says so.
        if (idx.type < 0 &&
            ((/credit/.test(t) && /debit/.test(t)) ||
             /^(tran(saction)?\s*)?type$/.test(t) ||
             /^(dr|cr)\s*[\/|-]\s*(cr|dr)$/.test(t))) { idx.type = j; return; }
        if (idx.check < 0 && /check\s*(number|num|no\.?|#)/.test(t)) { idx.check = j; return; }
        if (idx.date < 0 && /date|posted|posting/.test(t)) idx.date = j;
        else if (idx.desc < 0 && /desc|memo|payee|detail|narrat|transaction/.test(t)) idx.desc = j;
        if (/^bal|balance/.test(t)) idx.balance = j;
        else if (/debit|withdraw/.test(t)) idx.debit = j;
        else if (/credit|deposit/.test(t)) idx.credit = j;
        else if (idx.amount < 0 && /amount|amt/.test(t)) idx.amount = j;
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

    // --- sign, when a separate column carries it in words
    if (header && header.idx.type >= 0) {
      const s = signFromType(cols[header.idx.type]);
      // A file that says "Debit" and also prints the amount negative must not
      // be flipped back to positive, so work from the magnitude.
      if (s) amount = s * Math.abs(amount);
    }

    // --- description
    let description = '';
    if (header && header.idx.desc >= 0) description = cols[header.idx.desc];
    if (!description) {
      description = cols
        .filter((c, j) => j !== dateIdx && j !== amountIdx && !/^[\d.,$()-]+$/.test(c))
        .sort((a, b) => b.length - a.length)[0] || 'Transaction';
    }

    data.push({
      date, description, amount, raw: cols.join(','),
      // A column of its own beats reading the number out of the description.
      check_number: (function () {
        if (header && header.idx.check >= 0) {
          const n = parseInt(String(cols[header.idx.check]).replace(/[^\d]/g, ''), 10);
          if (n > 0) return n;
        }
        return checkNumberFrom(description, cols);
      }()),
    });
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

// Exported so the parser can be tested against a real bank's export without
// a database behind it. The shape of a bank file is where the silent errors
// live; it deserves tests of its own.
exports.parseCSV = parseCSV;

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
    const autoFilled = [];
    const writeAccount = async (balance, asOf) => {
      const row = onlyRealColumns(
        {
          account_id: resolvedId,
          store_id,
          // every plausible name for "what do you call this account"
          label,
          nickname: label,
          name: label,
          account_name: label,
          display_name: label,
          current_balance: balance,
          balance_as_of: asOf,
        },
        acctCols
      );
      const added = fillRequired(row, defs.bank_accounts || {}, label, asOf);
      added.forEach((c) => { if (autoFilled.indexOf(c) < 0) autoFilled.push(c); });
      return supabase.from('bank_accounts').upsert(row, { onConflict: 'account_id' });
    };

    if (accountCreated) {
      const seed = await writeAccount(0, pacificToday());
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
      const payload = fresh.slice(i, i + CHUNK).map((t) => {
        const row = onlyRealColumns(
          {
            account_id: resolvedId,
            store_id,
            posted_date: t.date,
            transaction_date: t.date,
            description: t.description,
            memo: t.description,
            amount: t.amount,
            import_batch: batchId,
            import_hash: t.hash,
            check_number: t.check_number,
            match_status: 'unmatched',
          },
          txnCols
        );
        const added = fillRequired(row, defs.bank_transactions || {}, t.description, t.date);
        added.forEach((c) => { if (autoFilled.indexOf(c) < 0) autoFilled.push(c); });
        return row;
      });
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

    // --- 3. what is still waiting to clear, in two queries -----------------
    const [checksRes, draftsRes] = await Promise.all([
      supabase
        .from('payments')
        .select('payment_id, check_number, amount, vendor_id, payment_date')
        .eq('store_id', store_id)
        .eq('method', 'check')
        .eq('status', 'outstanding'),
      // COD drafts and terms the bank pulls on its own. No check is ever
      // written for these, so nothing used to clear them.
      supabase
        .from('invoices')
        .select('invoice_id, vendor_id, total_amount, balance_due, due_date, payment_type, status')
        .eq('store_id', store_id)
        .in('payment_type', ['cod_draft', 'auto_debit'])
        .in('status', ['draft_pending', 'scheduled', 'approved']),
    ]);

    const openChecks = checksRes.data || [];
    const openDrafts = (draftsRes.data || []).filter((d) => Number(d.balance_due) > 0);
    const usedCheck = {};
    const usedDraft = {};

    // --- 4. match in memory ------------------------------------------------
    const hashToTxn = {};
    fresh.forEach((t) => { hashToTxn[t.hash] = t; });

    const sameMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

    const matches = [];       // checks we are confident about
    const draftMatches = [];  // drafts we are confident about
    const ambiguous = [];     // more than one candidate: a human decides

    // Debits only, biggest first, so a large unambiguous check is claimed
    // before a small one can soak up an exact-amount collision.
    const debits = [];
    for (const row of insertedRows) {
      const txn = hashToTxn[row.import_hash];
      if (!txn || txn.amount >= 0) continue;
      debits.push({ row, txn, target: Math.abs(txn.amount) });
    }
    debits.sort((a, b) => b.target - a.target);

    for (const d of debits) {
      const { row, txn, target } = d;
      const stmtNo = txn.check_number ? Number(txn.check_number) : null;

      const free = openChecks.filter((c) => !usedCheck[c.payment_id]);

      // Pass 1 — the statement names a check number and the amount agrees.
      // This is the only match that is certain.
      let hit = stmtNo
        ? free.find((c) => Number(c.check_number) === stmtNo && sameMoney(c.amount, target))
        : null;
      let how = hit ? 'number and amount' : null;

      // Pass 2 — the number agrees but the amount does not. The bank's number
      // is authoritative, so clear it and say the amount differed.
      if (!hit && stmtNo) {
        const byNo = free.find((c) => Number(c.check_number) === stmtNo);
        if (byNo) { hit = byNo; how = 'check number, amount differs'; }
      }

      // Pass 3 — no number on the statement. Amount alone is only safe when
      // exactly one open check could be it. Two candidates and we stop:
      // clearing the wrong check is worse than clearing nothing.
      if (!hit && !stmtNo) {
        const byAmt = free.filter((c) => sameMoney(c.amount, target));
        if (byAmt.length === 1) { hit = byAmt[0]; how = 'amount only'; }
        else if (byAmt.length > 1) {
          ambiguous.push({
            txn_id: row.bank_txn_id, date: txn.date, amount: target,
            candidates: byAmt.map((c) => c.check_number),
            why: byAmt.length + ' open checks are for this exact amount and the statement gives no check number',
          });
          continue;
        }
      }

      if (hit) {
        usedCheck[hit.payment_id] = 1;
        matches.push({
          txn_id: row.bank_txn_id, payment_id: hit.payment_id,
          check_number: hit.check_number, date: txn.date, how,
          amount_differs: !sameMoney(hit.amount, target),
        });
        continue;
      }

      // Not a check. A draft carries no number, so it is amount plus a due
      // date near the posting date — and again, only when it is unambiguous.
      const freeDrafts = openDrafts.filter((x) => !usedDraft[x.invoice_id]);
      const draftHits = freeDrafts.filter((x) => sameMoney(x.balance_due, target));
      if (draftHits.length === 1) {
        usedDraft[draftHits[0].invoice_id] = 1;
        draftMatches.push({ txn_id: row.bank_txn_id, invoice: draftHits[0], date: txn.date });
      } else if (draftHits.length > 1) {
        // Narrow by which due date sits closest to when the bank posted it.
        const near = draftHits
          .map((x) => ({ x, gap: x.due_date ? Math.abs(daysApart(x.due_date, txn.date)) : 999 }))
          .sort((a, b) => a.gap - b.gap);
        if (near[0].gap <= 3 && (near.length === 1 || near[1].gap > near[0].gap)) {
          usedDraft[near[0].x.invoice_id] = 1;
          draftMatches.push({ txn_id: row.bank_txn_id, invoice: near[0].x, date: txn.date });
        } else {
          ambiguous.push({
            txn_id: row.bank_txn_id, date: txn.date, amount: target,
            candidates: draftHits.map((x) => x.invoice_id),
            why: draftHits.length + ' vendor drafts are for this exact amount with no way to tell them apart',
          });
        }
      }
    }

    // --- 4b. write the clears ---------------------------------------------
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

    for (const m of draftMatches) {
      await supabase
        .from('bank_transactions')
        .update({ match_status: 'matched', matched_type: 'invoice', matched_id: m.invoice.invoice_id })
        .eq('bank_txn_id', m.txn_id);
      await supabase
        .from('invoices')
        // balance_due is generated from total_amount - amount_paid, so paying
        // it in full is what zeroes it. Sending the column is rejected.
        .update({
          status: 'paid',
          amount_paid: Number(m.invoice.total_amount),
        })
        .eq('invoice_id', m.invoice.invoice_id);
    }

    // Anything we would not swear to goes on the exceptions list for a human.
    for (const a of ambiguous) {
      await supabase.from('exceptions').insert({
        store_id,
        raised_by: 'bank-import',
        severity: 'warn',
        code: 'AMBIGUOUS_MATCH',
        entity_type: 'bank_transaction',
        entity_id: a.txn_id,
        message: 'A $' + a.amount.toFixed(2) + ' debit on ' + a.date + ' could not be matched with certainty.',
        suggested_action: a.why + '. Match it by hand on the Bank tab.',
        status: 'open',
      });
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
        latestDate || pacificToday()
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
          auto_filled_columns: autoFilled,
        },
        cleared_checks: matches.map((m) => m.check_number),
        cleared_how: matches.map((m) => ({
          check_number: m.check_number, matched_on: m.how, amount_differs: m.amount_differs,
        })),
        cleared_drafts: draftMatches.length,
        cleared_drafts_total: round(draftMatches.reduce((t, m) => t + Number(m.invoice.balance_due), 0)),
        needs_a_human: ambiguous,
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

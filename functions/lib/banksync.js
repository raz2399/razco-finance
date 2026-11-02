// Reading the bank, as a library.
//
// ---------------------------------------------------------------------
// Why this is not just plaid-sync any more
//
// plaid-sync is a SCHEDULED function. Netlify does not let a scheduled
// function be invoked by URL -- it answers 403 before the code runs at
// all, in 0.14ms, with a plain-text body that never reaches our own
// error handling.
//
// So "Read the bank now" on the Money screen has never once worked. It
// posted to plaid-sync, got a 403 from Netlify itself, and the screen
// sat on "Reading the bank..." The 4.30am run was fine, because that one
// comes from the scheduler. Only the button was dead, and nothing said so.
//
// The fix is not to copy the sync into a second file. It is to put it
// here, once, and let both callers use it: plaid-sync.js for the
// schedule, bank-read.js for the button.
//
// Pulls the bank every morning: both balances, every posted transaction,
// every pending one, and clears the checks that have gone through.
//
//   GET/POST ?store_id=store1   -> sync now
//
// Three things this gets right that the CSV never could:
//
//   1. Plaid's sign is the opposite of ours. In Plaid a POSITIVE amount is
//      money LEAVING the account. In bank_transactions, negative is money
//      out. Inverted once, here, at the boundary -- getting this backwards
//      is what put $811,139 of phantom money in the account in October.
//
//   2. Every transaction has an id from Plaid, so the same one is never
//      stored twice however often this runs. No fingerprint, nothing to
//      collide, and two identical $380 deposits on one day stay two.
//
//   3. Pending and posted are kept apart. A pending item later posts under
//      a new id that names the pending one; that row replaces it rather
//      than sitting beside it.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};
const json = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const PLAID_HOST = 'https://' + PLAID_ENV + '.plaid.com';

// Only production is real money.
//
// Plaid's sandbox connects to invented banks with invented balances. Left
// unguarded, setting the account up in sandbox would have written a made-up
// figure straight over the Bank of the Sierra balance, marked real checks
// cleared against transactions that never happened, and put all of it on
// the screen looking exactly like the truth.
//
// So outside production this runs and reports what it WOULD have done, and
// writes nothing. The connection can be proved without a single invented
// dollar reaching his books.
const LIVE = PLAID_ENV === 'production';

async function plaid(path, body) {
  const client_id = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!client_id || !secret) throw new Error('Plaid is not configured on this site.');

  const res = await fetch(PLAID_HOST + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ client_id, secret }, body)),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* not json */ }
  if (!res.ok) {
    const err = new Error((data && (data.error_message || data.error_code)) ||
                          ('Plaid returned ' + res.status));
    err.code = data && data.error_code;
    throw err;
  }
  return data;
}

// The one line that matters most in this file.
//
// Plaid: positive = money out of the account.
// Here:  negative = money out of the account.
//
// So the sign flips. A $149.12 check arrives from Plaid as +149.12 and is
// stored as -149.12.
const toLedgerAmount = (plaidAmount) => money(-Number(plaidAmount));

// What we keep from a Plaid transaction.
function toRow(t, storeId, accountId) {
  return {
    account_id: accountId,
    store_id: storeId,
    posted_date: t.date,
    description: t.name || t.merchant_name || 'Transaction',
    // Plaid's cleaned-up name, kept beside the raw one rather than
    // instead of it. "BBUSA BIMBO BAKERIES WEB RAZ *ALI" is what the
    // bank says; "Bimbo Bakeries" is what it means, and the vendor
    // matcher has a far easier time with the second.
    //
    // This used to be written to a column called memo, which does not
    // exist on this table. It never failed because the sandbox guard
    // skipped every write, so the first time it ran for real -- the day
    // the bank went live -- it took the whole sync down with it.
    merchant_name: t.merchant_name || null,
    amount: toLedgerAmount(t.amount),
    txn_type: Number(t.amount) > 0 ? 'debit' : 'credit',
    // Straight from the bank. The CSV made us read check numbers out of
    // prose; here the field is the field.
    check_number: t.check_number ? parseInt(String(t.check_number).replace(/[^\d]/g, ''), 10) || null : null,
    plaid_transaction_id: t.transaction_id,
    plaid_pending_id: t.pending_transaction_id || null,
    is_pending: !!t.pending,
    // import_hash is unique in this table and the CSV path relies on it, so
    // the Plaid id goes there too rather than leaving it empty.
    import_hash: 'plaid:' + t.transaction_id,
    match_status: 'unmatched',
  };
}

async function syncItem(item) {
  const storeId = item.store_id;
  let cursor = item.cursor || null;
  let added = [], modified = [], removed = [];
  let hasMore = true;
  let rounds = 0;

  // Plaid pages. The first sync of a new connection walks back two years,
  // which is several pages; a daily one is usually a single short page.
  while (hasMore && rounds < 40) {
    rounds += 1;
    const page = await plaid('/transactions/sync', {
      access_token: item.access_token,
      cursor: cursor || undefined,
      count: 500,
    });
    added = added.concat(page.added || []);
    modified = modified.concat(page.modified || []);
    removed = removed.concat(page.removed || []);
    cursor = page.next_cursor;
    hasMore = !!page.has_more;
  }

  const mine = (t) => !item.plaid_account_id || t.account_id === item.plaid_account_id;
  const incoming = added.concat(modified).filter(mine);

  // A pending transaction that has now posted: the posted row names it.
  // Drop the pending one rather than letting both stand.
  // Both of these DELETE. On a test connection they are deleting out of the
  // table holding a year of his real statement, on ids handed over by a
  // bank that is not his. Nothing should reach that table from a sandbox,
  // least of all a delete.
  const supersedes = incoming.map((t) => t.pending_transaction_id).filter(Boolean);
  if (LIVE && supersedes.length) {
    await supabase.from('bank_transactions')
      .delete().in('plaid_transaction_id', supersedes);
  }

  // Plaid can withdraw a transaction it previously reported.
  const gone = (removed || []).map((r) => r.transaction_id).filter(Boolean);
  if (LIVE && gone.length) {
    await supabase.from('bank_transactions').delete().in('plaid_transaction_id', gone);
  }

  let written = 0;
  const CHUNK = 200;
  for (let i = 0; i < incoming.length; i += CHUNK) {
    const rows = incoming.slice(i, i + CHUNK)
      .map((t) => toRow(t, storeId, item.account_id));
    if (LIVE) {
      // Conflicts are resolved on import_hash, not plaid_transaction_id.
      //
      // There IS a unique index on plaid_transaction_id, but it is a
      // PARTIAL one -- "WHERE plaid_transaction_id IS NOT NULL" -- and
      // Postgres will not use a partial index for ON CONFLICT unless the
      // statement repeats the predicate, which PostgREST cannot send.
      // The error it gives says nothing about partial indexes: it says
      // "there is no unique or exclusion constraint matching the ON
      // CONFLICT specification", which reads like the index is missing
      // when it is sitting right there.
      //
      // import_hash has a plain, total unique index, and toRow already
      // sets it to 'plaid:' + transaction_id -- one per Plaid
      // transaction, exactly as before. Same guarantee, through a door
      // Postgres will actually open.
      const res = await supabase.from('bank_transactions')
        .upsert(rows, { onConflict: 'import_hash' });
      if (res.error) throw new Error('Could not save transactions: ' + res.error.message);
    }
    written += rows.length;
  }

  // ---- balances ----------------------------------------------------------
  const bal = await plaid('/accounts/balance/get', { access_token: item.access_token });
  const acct = (bal.accounts || [])
    .filter((a) => !item.plaid_account_id || a.account_id === item.plaid_account_id)[0]
    || (bal.accounts || [])[0] || null;

  let balances = null;
  if (acct && item.account_id) {
    balances = {
      // current: what has posted. available: what the bank will let him
      // spend, which nets out pending. On this account those two were
      // $95,420 apart in one morning, so both are kept and the screens say
      // which one they are showing.
      current: money(acct.balances.current),
      available: acct.balances.available === null || acct.balances.available === undefined
        ? null : money(acct.balances.available),
    };
    if (LIVE) {
      await supabase.from('bank_accounts').update({
        current_balance: balances.current,
        available_balance: balances.available,
        balance_as_of: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
        balance_source: 'plaid',
      }).eq('account_id', item.account_id);
    }
  }

  await supabase.from('plaid_items').update({
    cursor,
    last_synced_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq('item_id', item.item_id);

  return {
    item_id: item.item_id,
    bank: item.institution_name,
    environment: PLAID_ENV,
    // Said on every reply, not buried in a log. A test run that reads like
    // a real one is how invented figures end up believed.
    live: LIVE,
    saved: LIVE,
    note: LIVE ? null : 'TEST CONNECTION (' + PLAID_ENV + '). Plaid sandbox banks are not yours '
      + 'and these figures are invented. Nothing was saved: your balance, '
      + 'your transactions and your checks are untouched.',
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    written,
    pending: incoming.filter((t) => t.pending).length,
    balances,
  };
}

// ---- clearing checks -------------------------------------------------------
// The number comes from the bank now, so this is an exact match on the
// number and the amount rather than reading digits out of a description.
async function clearChecks(storeId) {
  // Nothing to match against outside production: no sandbox transaction was
  // saved, so there is nothing here that could clear a real check. Guarded
  // anyway rather than relying on that, because a check marked cleared is a
  // check he stops expecting to leave the bank.
  if (!LIVE) return { cleared: [], differing: [], skipped: 'not a live connection' };

  const [outRes, txnRes] = await Promise.all([
    supabase.from('payments')
      .select('payment_id, check_number, amount, payment_date')
      .eq('store_id', storeId).eq('method', 'check').eq('status', 'outstanding'),
    supabase.from('bank_transactions')
      .select('bank_txn_id, check_number, amount, posted_date, is_pending, match_status')
      .eq('store_id', storeId).eq('is_pending', false).eq('match_status', 'unmatched')
      .not('check_number', 'is', null),
  ]);

  const cleared = [];
  const differing = [];
  const txns = txnRes.data || [];

  for (const p of (outRes.data || [])) {
    if (!p.check_number) continue;
    const hit = txns.filter((t) =>
      Number(t.check_number) === Number(p.check_number) && t.match_status === 'unmatched')[0];
    if (!hit) continue;

    const paid = Math.abs(money(hit.amount));
    const wrote = Math.abs(money(p.amount));

    await supabase.from('payments').update({
      status: 'cleared',
      cleared_date: hit.posted_date,
      bank_txn_id: hit.bank_txn_id,
    }).eq('payment_id', p.payment_id);

    await supabase.from('bank_transactions').update({
      match_status: 'matched', matched_type: 'payment', matched_id: p.payment_id,
    }).eq('bank_txn_id', hit.bank_txn_id);
    hit.match_status = 'matched';

    cleared.push({ check_number: p.check_number, amount: paid, date: hit.posted_date });

    // Cleared for a different amount than it was written for. The check is
    // still cleared -- the money has gone -- but somebody should look.
    if (paid !== wrote) {
      differing.push({ check_number: p.check_number, written_for: wrote, cleared_for: paid });
      await supabase.from('exceptions').insert({
        store_id: storeId, raised_by: 'plaid-sync', severity: 'warn',
        code: 'CHECK_AMOUNT_DIFFERS', entity_type: 'payment', entity_id: p.payment_id,
        message: 'Check #' + p.check_number + ' was written for $' + wrote.toFixed(2) +
                 ' and cleared for $' + paid.toFixed(2) + '.',
        suggested_action: 'Check the stub against the bank.',
        status: 'open',
      });
    }
  }
  return { cleared, differing };
}


/**
 * Pull one store's banks and clear what cleared.
 *
 * Returns the same shape the endpoint used to return, so both callers
 * and the tests see exactly what they saw before.
 */
async function syncStore(store_id) {
  const itemsRes = await supabase.from('plaid_items')
    .select('item_id, store_id, account_id, access_token, institution_name, plaid_account_id, cursor')
    .eq('store_id', store_id).eq('status', 'active');

  const items = itemsRes.data || [];
  if (!items.length) {
    return { ok: true, connected: false, note: 'No bank is connected yet.' };
  }

  const results = [];
  for (const item of items) {
    try {
      results.push(await syncItem(item));
    } catch (err) {
      // One broken connection must not stop the others, and the reason
      // belongs where somebody will see it rather than in a log nobody
      // reads. ITEM_LOGIN_REQUIRED means the bank wants him to sign in
      // again -- common, and not a fault.
      await supabase.from('plaid_items').update({
        last_error: err.message,
        status: err.code === 'ITEM_LOGIN_REQUIRED' ? 'needs_login' : 'active',
        updated_at: new Date().toISOString(),
      }).eq('item_id', item.item_id);

      results.push({ item_id: item.item_id, error: err.message, code: err.code || null });
    }
  }

  const checks = await clearChecks(store_id);

  return {
    ok: true,
    connected: true,
    environment: PLAID_ENV,
    live: LIVE,
    synced: results,
    checks_cleared: checks.cleared,
    checks_cleared_count: checks.cleared.length,
    checks_differing: checks.differing,
  };
}

module.exports = {
  syncStore,
  clearChecks,
  toLedgerAmount,
  toRow,
  PLAID_ENV,
  LIVE,
};

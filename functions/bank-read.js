// Netlify Function: bank-read
// "Read the bank now" -- the button on the Money screen.
//
//   POST { store_id }   -> pull balances and transactions, clear checks
//
// ---------------------------------------------------------------------
// Why this file exists at all
//
// The button used to post to plaid-sync. plaid-sync is scheduled, and
// Netlify refuses to invoke a scheduled function by URL: it returns 403
// before the function runs, in a fraction of a millisecond, with a
// plain-text body that never touches our own error handling. The screen
// showed "Reading the bank..." and then nothing, for weeks, and the only
// trace was a 403 in a log nobody was reading.
//
// Nothing was wrong with the sync. It was the door.
//
// So the sync lives in lib/banksync.js now, the scheduler calls it
// through plaid-sync.js, and this calls it through the front door with a
// sign-in check on it -- because unlike the scheduler, this one is
// reachable by anyone who knows the URL.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { syncStore, PLAID_ENV, LIVE } = require('./lib/banksync');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

exports.handler = safely('bank-read', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { body = {}; }
  }
  const store_id = body.store_id || q.store_id || 'store1';

  const result = await syncStore(store_id);

  if (!result.connected) {
    return json(200, {
      ok: true,
      connected: false,
      message: 'No bank is connected yet.',
    });
  }

  const errors = (result.synced || []).filter((s) => s.error);
  const added = (result.synced || []).reduce((n, s) => n + (s.added || 0), 0);
  const cleared = result.checks_cleared_count || 0;

  // Said in words, because the figure alone does not tell him whether
  // anything actually happened.
  let message;
  if (errors.length) {
    message = 'The bank answered with a problem: ' + errors[0].error;
  } else if (!LIVE) {
    message = 'Read the bank, but this is the ' + PLAID_ENV + ' connection, '
      + 'so nothing was saved.';
  } else if (!added && !cleared) {
    message = 'Read the bank. Nothing new since the last read.';
  } else {
    message = 'Read the bank. '
      + (added ? added + ' new transaction' + (added === 1 ? '' : 's') : 'No new transactions')
      + (cleared ? ', ' + cleared + ' check' + (cleared === 1 ? '' : 's') + ' cleared' : '')
      + '.';
  }

  return json(errors.length ? 502 : 200, Object.assign({}, result, { message: message }));
});

// Netlify Function: plaid-sync  (SCHEDULED -- 11:30 UTC, see netlify.toml)
//
// This one is run by the scheduler and by nothing else. Netlify will not
// let a scheduled function be invoked by URL: it answers 403 before the
// code runs at all, which is exactly what the "Read the bank now" button
// had been quietly collecting for weeks.
//
// So the work lives in lib/banksync.js and this file is the alarm clock.
// The button posts to bank-read.js, which calls the same library.
//
// There is no sign-in check here on purpose. Nobody can reach this over
// HTTP to begin with, and the scheduler carries no session.

const { syncStore } = require('./lib/banksync');

const STORE = process.env.DEFAULT_STORE_ID || 'store1';

exports.handler = async () => {
  try {
    const result = await syncStore(STORE);
    // Goes to the function log, which is where a scheduled run's output
    // is read from. Nobody is watching at 4.30 in the morning.
    console.log('plaid-sync', JSON.stringify({
      connected: result.connected,
      live: result.live,
      checks_cleared: result.checks_cleared_count || 0,
      items: (result.synced || []).length,
      errors: (result.synced || []).filter((s) => s.error).map((s) => s.error),
    }));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('plaid-sync FAILED:', err && err.stack ? err.stack : err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Kept so the existing tests can reach them by their old names.
const lib = require('./lib/banksync');
exports.toLedgerAmount = lib.toLedgerAmount;
exports.toRow = lib.toRow;

// A short-lived link that lets a browser fetch one print run.
//
// ---------------------------------------------------------------------
// Why this exists
//
// The phone cannot print. iOS prints through Safari's share sheet, so
// the phone has to hand the browser a URL -- and a browser opened with
// Linking.openURL carries no Authorization header. Nothing of the app's
// session goes with it.
//
// The lazy answers are both wrong. Leaving the page unauthenticated puts
// every check the store has written behind a guessable URL. Putting the
// session token in the query string writes it into browser history, the
// iOS share sheet, and any server log in between.
//
// So: a token that is signed, scoped to one run, and dead in ten
// minutes. It names the payments it covers and nothing else -- it cannot
// be edited into a different run, because the signature covers the list.
//
// Signed with the service key, which never leaves the server. The token
// carries no secret itself: worst case somebody sees three checks they
// were already about to be handed on paper, for ten minutes.

const crypto = require('crypto');

const TEN_MINUTES = 10 * 60 * 1000;

function key() {
  const k = process.env.SUPABASE_SERVICE_KEY;
  if (!k) throw new Error('No signing key is configured on this site.');
  return k;
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (s) => Buffer.from(
  String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', key()).update(body).digest());
  return body + '.' + mac;
}

/**
 * Make a token for one print run.
 */
function mint(store_id, payment_ids) {
  return sign({
    s: store_id,
    p: payment_ids,
    e: Date.now() + TEN_MINUTES,
  });
}

/**
 * Read one back, or null.
 *
 * Returns null for anything that is not exactly right: wrong shape, bad
 * signature, expired. A caller that gets null must refuse -- there is no
 * partial credit here.
 */
function open(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;

  const expected = b64url(crypto.createHmac('sha256', key()).update(parts[0]).digest());
  // Constant-time, so the comparison cannot be used to guess a signature
  // one character at a time.
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try { payload = JSON.parse(unb64url(parts[0])); } catch (e) { return null; }

  if (!payload || !payload.s || !Array.isArray(payload.p) || !payload.e) return null;
  if (Date.now() > Number(payload.e)) return null;

  return { store_id: payload.s, payment_ids: payload.p, expires: Number(payload.e) };
}

module.exports = { mint, open, TEN_MINUTES };

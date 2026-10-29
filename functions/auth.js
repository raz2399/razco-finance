// Netlify Function: auth
// Signing in.
//
//   POST { action: 'login',   email, password } -> tokens
//   POST { action: 'refresh', refresh_token }   -> fresh tokens
//   GET  (with Bearer token)                    -> who am I
//
// The password goes from the page to here to Supabase and is never written
// down anywhere in between -- not in a log, not in an error, not in the
// database. This system stores no passwords at all.
//
// The page talks to this rather than to Supabase directly, so the browser
// never has to carry a Supabase key of any kind.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

async function gotrue(path, body) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SERVICE_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

exports.handler = safely('auth', async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    // ---------------- who am I ----------------
    if (event.httpMethod === 'GET') {
      const auth = await requireUser(event, supabase);
      if (!auth.ok) return json(auth.status, { error: auth.error, signed_in: false });
      return json(200, { signed_in: true, user: auth.user });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Use GET or POST.' });
    const body = JSON.parse(event.body || '{}');

    // ---------------- sign in ----------------
    if (body.action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) return json(400, { error: 'Email and password, please.' });

      const out = await gotrue('token?grant_type=password', { email, password });

      if (!out.ok) {
        // Deliberately the same answer for a wrong password and an email
        // that does not exist. Telling them apart tells a stranger which
        // addresses are real.
        return json(401, { error: 'That email and password do not match.' });
      }

      // Signed in to Supabase is not the same as allowed in here. A person
      // can hold a Supabase account and have no business seeing the books.
      const probe = await requireUser(
        { httpMethod: 'GET', headers: { Authorization: 'Bearer ' + out.data.access_token } },
        supabase
      );
      if (!probe.ok) return json(probe.status, { error: probe.error });

      return json(200, {
        access_token: out.data.access_token,
        refresh_token: out.data.refresh_token,
        expires_in: out.data.expires_in,
        user: probe.user,
      });
    }

    // ---------------- stay signed in ----------------
    if (body.action === 'refresh') {
      if (!body.refresh_token) return json(400, { error: 'Missing refresh_token' });
      const out = await gotrue('token?grant_type=refresh_token', {
        refresh_token: body.refresh_token,
      });
      if (!out.ok) return json(401, { error: 'That session has expired. Sign in again.' });

      const probe = await requireUser(
        { httpMethod: 'GET', headers: { Authorization: 'Bearer ' + out.data.access_token } },
        supabase
      );
      if (!probe.ok) return json(probe.status, { error: probe.error });

      return json(200, {
        access_token: out.data.access_token,
        refresh_token: out.data.refresh_token,
        expires_in: out.data.expires_in,
        user: probe.user,
      });
    }

    // ---------------- sign out ----------------
    if (body.action === 'logout') {
      // The page drops its tokens either way; this ends the session at
      // Supabase so the refresh token cannot be used again.
      const token = (event.headers || {}).authorization || '';
      const m = /^Bearer\s+(.+)$/i.exec(String(token).trim());
      if (m) {
        await fetch(SUPABASE_URL + '/auth/v1/logout', {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + m[1] },
        }).catch(() => {});
      }
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    // Never the underlying message: an auth error is the last place to leak
    // what the server knows.
    return json(500, { error: 'Could not sign in just now.' });
  }
});

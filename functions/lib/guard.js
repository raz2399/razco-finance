// Who is asking.
//
// Every endpoint that touches store data calls requireUser first. Until
// now there was nothing: the URL was the only thing standing between a
// stranger and the bank position, and a URL is not a secret.
//
// Identity is Supabase's, not ours. The schema carries a password_hash
// column from a hand-rolled attempt that was never finished, and finishing
// it would have meant writing password hashing, reset flows, session
// expiry and lockout for a system that holds a bank balance. Supabase ships
// all of that already and it is the same project the data is in.
//
// This file lives under functions/lib/ rather than functions/ because
// Netlify turns every top-level .js in the functions directory into an
// endpoint of its own, and this is a helper, not an endpoint.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Machine callers. The store PC posts register data on a schedule with
// nobody sitting at it, so it carries a token of its own instead.
const SYNC_TOKEN = process.env.SYNC_TOKEN;

function bearer(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1] : null;
}

// Ask Supabase who this token belongs to. Verifying the signature here
// would be faster, but it would also mean a token stays good after the
// person is removed -- asking means revoking actually revokes.
async function whoIs(token) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

// Returns { ok: true, user } or { ok: false, status, error }.
//
// `user` carries the stores this person may see. A caller must never read
// the store_id from the request and trust it: that is how one account ends
// up reading another store's books by changing a query string.
async function requireUser(event, supabase, options) {
  const opts = options || {};

  if (event.httpMethod === 'OPTIONS') return { ok: true, preflight: true, user: null };

  // A machine caller, where that endpoint allows one.
  if (opts.allowSyncToken && SYNC_TOKEN) {
    const body = (() => { try { return JSON.parse(event.body || '{}'); } catch (e) { return {}; } })();
    const offered = body.token || (event.headers || {})['x-sync-token'];
    if (offered && offered === SYNC_TOKEN) {
      return { ok: true, machine: true, user: { user_id: null, role: 'machine', stores: null } };
    }
  }

  const token = bearer(event);
  if (!token) {
    return { ok: false, status: 401, error: 'Sign in to see this.' };
  }

  let who;
  try {
    who = await whoIs(token);
  } catch (err) {
    // The auth service being unreachable is not permission to proceed.
    return { ok: false, status: 503, error: 'Could not check who you are. Try again.' };
  }
  if (!who) return { ok: false, status: 401, error: 'That session has expired. Sign in again.' };

  const [profileRes, accessRes] = await Promise.all([
    supabase.from('app_users')
      .select('user_id, full_name, role, active, approval_limit')
      .eq('user_id', who.id).maybeSingle(),
    supabase.from('user_store_access').select('store_id').eq('user_id', who.id),
  ]);

  const profile = profileRes.data;
  // Signed in to Supabase but not set up in this system. Real for anyone
  // who creates an account and has not been given access, and the honest
  // answer is no, not a blank screen.
  if (!profile) {
    return { ok: false, status: 403, error: 'This account has no access to Razi-Nova yet.' };
  }
  if (profile.active === false) {
    return { ok: false, status: 403, error: 'This account has been turned off.' };
  }

  const stores = (accessRes.data || []).map((r) => r.store_id);
  if (!stores.length) {
    return { ok: false, status: 403, error: 'This account is not attached to a store.' };
  }

  return {
    ok: true,
    user: {
      user_id: who.id,
      email: who.email || null,
      name: profile.full_name,
      role: profile.role,
      approval_limit: profile.approval_limit,
      stores,
    },
  };
}

// Which store this request is allowed to act on.
//
// The store comes from the request, so it is a claim, not a fact. Checked
// against what the account may see, every time.
function storeFor(user, asked) {
  if (!user) return null;
  if (user.role === 'machine') return asked || null;
  if (!asked) return user.stores[0];
  return user.stores.indexOf(asked) > -1 ? asked : null;
}

module.exports = { requireUser, storeFor, bearer };

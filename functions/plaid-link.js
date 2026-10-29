// Netlify Function: plaid-link
// Connecting the bank account, once.
//
//   GET  ?store_id=store1              -> is a bank connected, and to what
//   POST { store_id, action:'token' }  -> a link token, to open Plaid Link
//   POST { store_id, action:'exchange', public_token, institution, account }
//                                      -> store the connection
//   POST { store_id, action:'disconnect' } -> forget it
//
// Raz's bank login is typed into Plaid's own window and never reaches this
// server, this database or the browser's page. What comes back is an access
// token for the account -- still a credential that can read every
// transaction, so it is written to a table only the service role can read
// and is never sent to a browser, logged, or put in an error message.

const { createClient } = require('@supabase/supabase-js');
const { requireUser } = require('./lib/guard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// sandbox while it is being set up, production once the account is live.
// Nothing else in the code changes between the two.
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const PLAID_HOST = 'https://' + PLAID_ENV + '.plaid.com';

function credentials() {
  const id = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!id || !secret) return null;
  return { client_id: id, secret };
}

async function plaid(path, body) {
  const creds = credentials();
  if (!creds) throw new Error('Plaid is not configured on this site yet.');

  const res = await fetch(PLAID_HOST + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, creds, body)),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* not json */ }

  if (!res.ok) {
    // Plaid's own words. Its error messages name the institution and what
    // the person should do, which is more use than a status code.
    const msg = (data && (data.error_message || data.error_code)) ||
                ('Plaid returned ' + res.status);
    const err = new Error(msg);
    err.plaid = data || null;
    throw err;
  }
  return data;
}

exports.handler = async (event) => {
  // Nobody sees any of this without signing in. Before this, the URL was
  // the only thing between a stranger and the bank position, and a URL is
  // not a secret: it is in browser history, in a chat message, on a screen
  // in a stockroom.
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const q = event.queryStringParameters || {};
    const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
    const store_id = body.store_id || q.store_id;
    if (!store_id) return json(400, { error: 'Missing store_id' });

    // ---------------- what is connected ----------------
    if (event.httpMethod === 'GET') {
      const res = await supabase
        .from('plaid_items')
        // Never the access token. Nothing asks a browser to hold a
        // credential it has no use for.
        .select('item_id, institution_name, mask, status, last_synced_at, last_error')
        .eq('store_id', store_id)
        .eq('status', 'active');

      const items = res.data || [];
      return json(200, {
        configured: !!credentials(),
        environment: PLAID_ENV,
        connected: items.length > 0,
        accounts: items.map((i) => ({
          item_id: i.item_id,
          bank: i.institution_name || 'Bank',
          mask: i.mask ? '••' + i.mask : null,
          last_synced_at: i.last_synced_at,
          last_error: i.last_error,
        })),
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Use GET or POST.' });

    if (!credentials()) {
      return json(503, {
        error: 'Plaid is not set up on this site yet. PLAID_CLIENT_ID and ' +
               'PLAID_SECRET need to be set in the Netlify environment.',
      });
    }

    // ---------------- a token to open Plaid Link ----------------
    if (body.action === 'token') {
      const out = await plaid('/link/token/create', {
        user: { client_user_id: store_id },
        client_name: 'Razi-Nova Finance',
        // transactions carries the balance too, so this is the only product
        // needed: every posted item, every pending one, and both balances.
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
      });
      return json(200, { link_token: out.link_token, expiration: out.expiration });
    }

    // ---------------- keep the connection ----------------
    if (body.action === 'exchange') {
      if (!body.public_token) return json(400, { error: 'Missing public_token' });

      const ex = await plaid('/item/public_token/exchange', {
        public_token: body.public_token,
      });

      // Which of the accounts behind this login is the operating account.
      const accounts = await plaid('/accounts/get', { access_token: ex.access_token });
      const list = (accounts.accounts || []);
      const picked = body.plaid_account_id
        ? list.filter((a) => a.account_id === body.plaid_account_id)[0]
        // Default to the first checking account rather than the first
        // account of any kind: a savings account would look plausible and
        // be wrong.
        : (list.filter((a) => a.subtype === 'checking')[0] || list[0]);

      const existing = await supabase
        .from('bank_accounts').select('account_id')
        .eq('store_id', store_id).eq('active', true).limit(1).maybeSingle();

      const row = {
        item_id: ex.item_id,
        store_id,
        account_id: existing.data ? existing.data.account_id : null,
        access_token: ex.access_token,
        institution_name: body.institution || (accounts.item && accounts.item.institution_id) || null,
        plaid_account_id: picked ? picked.account_id : null,
        mask: picked ? picked.mask : null,
        status: 'active',
        cursor: null,
        updated_at: new Date().toISOString(),
      };

      const saved = await supabase.from('plaid_items').upsert(row, { onConflict: 'item_id' });
      if (saved.error) return json(500, { error: 'Could not save the connection: ' + saved.error.message });

      return json(200, {
        ok: true,
        bank: row.institution_name,
        mask: row.mask ? '••' + row.mask : null,
        accounts: list.map((a) => ({
          plaid_account_id: a.account_id, name: a.name,
          subtype: a.subtype, mask: a.mask,
        })),
        next: 'Connected. The first sync will pull the last two years.',
      });
    }

    // ---------------- forget it ----------------
    if (body.action === 'disconnect') {
      const rows = await supabase.from('plaid_items')
        .select('item_id, access_token').eq('store_id', store_id).eq('status', 'active');

      for (const it of (rows.data || [])) {
        // Tell Plaid as well, so the connection stops existing on their side
        // rather than only here. A failure there is not a reason to keep a
        // credential we have been asked to drop.
        try { await plaid('/item/remove', { access_token: it.access_token }); } catch (e) { /* drop it anyway */ }
        await supabase.from('plaid_items')
          .update({ status: 'removed', access_token: 'removed', updated_at: new Date().toISOString() })
          .eq('item_id', it.item_id);
      }
      return json(200, { ok: true, removed: (rows.data || []).length });
    }

    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    return json(500, { error: err.message, where: 'plaid-link' });
  }
};

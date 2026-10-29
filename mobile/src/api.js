// Every call the app makes. It talks to the same endpoints the dashboard
// does, so a number here can never disagree with a number on the desktop.

import Constants from 'expo-constants';

const BASE =
  (Constants.expoConfig &&
    Constants.expoConfig.extra &&
    Constants.expoConfig.extra.apiBase) ||
  'https://famous-caramel-1cf571.netlify.app/.netlify/functions';

let STORE_ID = 'store1';

// The session is kept on the device, in the keychain.
//
// It used to live in memory only, which meant every restart of the app put
// him back at the sign-in screen -- and a restart is not a rare thing: iOS
// kills a backgrounded app whenever it likes, and applying an update is a
// restart too. That turned every new version into a password prompt, which
// is why updates could not simply apply themselves.
//
// Required rather than imported, and null-checked at every use. The module
// is native, so a JavaScript bundle carrying this code must never run on a
// build that does not have it: an import would throw at startup and the
// app would not open at all. The app version was bumped for this build so
// the runtime versions differ and the old binary is never served this
// bundle -- but a missing module here degrades to an in-memory session
// rather than a phone that will not start.
let SecureStore = null;
try {
  // eslint-disable-next-line global-require
  SecureStore = require('expo-secure-store');
} catch (e) {
  SecureStore = null;
}

const SESSION_KEY = 'razinova_session';

let session = { access: null, refresh: null, user: null, expires_at: null };

export const getSession = () => session;
export const isSignedIn = () => !!session.access;

function remember() {
  if (!SecureStore || !SecureStore.setItemAsync) return;
  // Not awaited. Nothing the person does should wait on a disk write, and
  // a failed write costs them a sign-in, not their data.
  SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session)).catch(() => {});
}

function forget() {
  if (!SecureStore || !SecureStore.deleteItemAsync) return;
  SecureStore.deleteItemAsync(SESSION_KEY).catch(() => {});
}

/**
 * Brings back the session from the last time, if there is one.
 *
 * The access token will nearly always be stale by now -- it only lasts an
 * hour and the phone has been in a pocket -- so this renews it on the spot
 * rather than letting the first screen fail and sort itself out.
 *
 * Returns true if he is signed in.
 */
export async function restoreSession() {
  if (!SecureStore || !SecureStore.getItemAsync) return false;
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.refresh) return false;

    session = {
      access: saved.access || null,
      refresh: saved.refresh,
      user: saved.user || null,
      expires_at: saved.expires_at || null,
    };
    if (saved.user && saved.user.stores && saved.user.stores.length) {
      STORE_ID = saved.user.stores[0];
    }

    await freshEnough(true);
    return !!session.access;
  } catch (e) {
    // A keychain that will not open is not a reason to fail to start.
    return false;
  }
}

function setSession(d) {
  session = {
    access: d.access_token || null,
    refresh: d.refresh_token || null,
    user: d.user || null,
    // When this token stops working. Supabase hands out an hour, and an
    // hour is exactly how long it took for the app to start failing on
    // him while he was using it.
    expires_at: d.expires_at
      ? Number(d.expires_at) * 1000
      : (d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : null),
  };
  if (d.user && d.user.stores && d.user.stores.length) STORE_ID = d.user.stores[0];
  remember();
  return session;
}

// Renew before it dies rather than after.
//
// Waiting for a 401 and then renewing works, but only if the server is
// well enough to say 401. The night this was written it was not: it
// crashed instead, the app saw a 502, and a 502 is not a reason to renew
// a session -- so nothing renewed, and every screen stayed broken until
// he signed in again by hand. Renewing a minute early needs nothing to go
// right.
const RENEW_WITHIN_MS = 120000;
let renewing = null;

async function freshEnough(force) {
  if (!session.refresh) return;
  // force is for waking the app up: whatever the clock says, a token that
  // has been sitting on a shelf since last night is renewed before the
  // first screen asks for anything.
  if (!force && !session.expires_at) return;
  if (!force && Date.now() < session.expires_at - RENEW_WITHIN_MS) return;
  // One renewal at a time, however many calls notice at once.
  if (!renewing) {
    renewing = (async () => {
      try {
        const d = await call('/auth', {
          method: 'POST',
          body: JSON.stringify({ action: 'refresh', refresh_token: session.refresh }),
        }, true);
        if (d && d.access_token) setSession(d);
      } catch (e) {
        // Leave the old token in place and let the call fail honestly.
      } finally {
        renewing = null;
      }
    })();
  }
  await renewing;
}

export function clearSession() {
  session = { access: null, refresh: null, user: null, expires_at: null };
  forget();
}

// Raised when the server says the session is over. The app shows the
// sign-in screen rather than painting it on a card as if it were a
// problem with the data.
export class NotSignedIn extends Error {
  constructor(message) {
    super(message || 'Sign in to see this.');
    this.name = 'NotSignedIn';
  }
}

async function call(path, options = {}, retrying = false) {
  if (!retrying && path !== '/auth') await freshEnough();

  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}store_id=${encodeURIComponent(STORE_ID)}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(session.access ? { Authorization: `Bearer ${session.access}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    // A dead phone signal and a dead server are different problems and the
    // person should be told which one they have.
    throw new Error('No connection. Check the phone signal and try again.');
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* not json */ }

  if (res.status === 401 || res.status === 403) {
    // One attempt to renew, then the session really is over. Retrying
    // forever would spin while he stares at a blank screen.
    if (!retrying && session.refresh && path !== '/auth') {
      try {
        const fresh = await call('/auth', {
          method: 'POST',
          body: JSON.stringify({ action: 'refresh', refresh_token: session.refresh }),
        }, true);
        if (fresh && fresh.access_token) {
          setSession(fresh);
          return call(path, options, true);
        }
      } catch (e) { /* fall through to signing out */ }
    }
    clearSession();
    throw new NotSignedIn((data && data.error) || 'Sign in again.');
  }

  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.error) || `The server returned ${res.status}.`);
  }
  return data;
}

// Signing in. The password goes straight to the server and is not kept
// anywhere on the phone, not even for the length of this call.
export async function login(email, password) {
  const d = await call('/auth', {
    method: 'POST',
    body: JSON.stringify({ action: 'login', email: String(email).trim(), password }),
  });
  return setSession(d);
}

export async function logout() {
  try {
    await call('/auth', { method: 'POST', body: JSON.stringify({ action: 'logout' }) });
  } catch (e) { /* going either way */ }
  clearSession();
}

export const getOverview = (weekStart) =>
  call(`/overview${weekStart ? `?week_start=${weekStart}` : ''}`);

export const getClose = (weekStart) =>
  call(`/weekly-close${weekStart ? `?week_start=${weekStart}` : ''}`);

export const closeWeek = (weekStart, cashOnHand) =>
  call('/weekly-close', {
    method: 'POST',
    body: JSON.stringify({ store_id: STORE_ID, week_start: weekStart, cash_on_hand: cashOnHand }),
  });

export const getInvoices = () => call('/invoices');

// Just the vendor names, for the suggestion list at the dock.
export const getVendorList = () => call('/invoices?vendors_only=1');

export const saveInvoice = (invoice) =>
  call('/invoices', {
    method: 'POST',
    body: JSON.stringify({ store_id: STORE_ID, ...invoice }),
  });

export const getChecks = () => call('/checks');

// What the system currently believes, and the history of every correction.
export const getCorrections = () => call('/correct');

// Replace a figure the system got wrong. target is 'bank' or 'cash'.
// The counted number wins: a figure a person counted beats one a computer
// inferred. Every change is written down with a reason.
export const correctFigure = (target, amount, note) =>
  call('/correct', {
    method: 'POST',
    body: JSON.stringify({ store_id: STORE_ID, target, amount, note }),
  });

// Undo an entry that should never have been recorded.
export const voidEntry = (kind, id, note) =>
  call('/correct', {
    method: 'POST',
    body: JSON.stringify({ store_id: STORE_ID, action: 'void', kind, id, note }),
  });


// Vendors, with what is owed against each. The search runs on the server so
// the phone is never holding all 255 of them to filter.
export const findVendors = (q) =>
  call('/vendor-ledger' + (q ? '?q=' + encodeURIComponent(q) : ''));

// One vendor's lines -- every invoice and every payment, not a total.
// sort is date | number | amount | type | entered.
export const getVendorLedger = (vendorId, sort, dir, openOnly) =>
  call('/vendor-ledger?vendor_id=' + encodeURIComponent(vendorId) +
       '&sort=' + (sort || 'date') + '&dir=' + (dir || 'desc') +
       (openOnly ? '&include=open' : ''));

// Putting a line on a vendor by hand, correcting one, and clearing one.
//
// "Already paid" and "pay it now" are two different things and the names
// keep them apart. settle clears the balance and writes NO payment,
// because the money did not leave through this system -- inventing one
// would show a check leaving the bank that never left it. pay_now writes
// a real payment.
const entry = (body) =>
  call('/vendor-entry', { method: 'POST', body: JSON.stringify(body) });

export const addVendorInvoice = (fields) =>
  entry({ action: 'add_invoice', ...fields });

export const addVendorPayment = (fields) =>
  entry({ action: 'add_payment', ...fields });

export const editVendorLine = (kind, id, fields) =>
  entry({ action: 'edit', kind, id, fields });

export const voidVendorLine = (kind, id, note) =>
  entry({ action: 'void', kind, id, note });

// Already paid, elsewhere. No payment row.
export const settleInvoices = (invoiceIds) =>
  entry({ action: 'settle', invoice_ids: invoiceIds });

export const unsettleInvoices = (invoiceIds) =>
  entry({ action: 'unsettle', invoice_ids: invoiceIds });

export const settleWholeVendor = (vendorId) =>
  entry({ action: 'settle', vendor_id: vendorId, all_open: true });

// Paying it now, from here. This one does write a payment.
export const payWholeVendor = (vendorId, method, checkNumber, payDate) =>
  entry({
    action: 'pay_now', vendor_id: vendorId, all_open: true,
    method, check_number: checkNumber, payment_date: payDate,
  });

// A day at the register: by tender, by department, by cashier.
export const getDay = (date) => call('/day' + (date ? '?date=' + date : ''));

// Read a photograph of paper. kind is 'invoice', 'check' or 'statement'.
// It returns a draft to confirm — nothing is saved by this call.
export const readPaper = (kind, base64, mime) =>
  call('/invoice-extract', {
    method: 'POST',
    body: JSON.stringify({ store_id: STORE_ID, kind, base64_image: base64, mime_type: mime }),
  });

// Lindsay's today. toISOString() is UTC, and from five in the afternoon
// Pacific that is already tomorrow -- which is exactly when the back
// office is being worked.
export const todayPacific = () => {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  } catch (e) {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
};

export const money = (n, cents = false) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return (
    sign +
    '$' +
    abs.toLocaleString('en-US', {
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    })
  );
};

export const STORE = () => STORE_ID;

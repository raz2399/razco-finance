// Every call the app makes. It talks to the same endpoints the dashboard
// does, so a number here can never disagree with a number on the desktop.

import Constants from 'expo-constants';

const BASE =
  (Constants.expoConfig &&
    Constants.expoConfig.extra &&
    Constants.expoConfig.extra.apiBase) ||
  'https://famous-caramel-1cf571.netlify.app/.netlify/functions';

let STORE_ID = 'store1';

// The session lives in memory for now. React Native has no localStorage,
// and the two ways to keep something on the device -- expo-secure-store and
// AsyncStorage -- are native modules, which means a new build and another
// trip through TestFlight. So this ships without them: he signs in again
// when the app has been fully closed. The next build will remember him.
let session = { access: null, refresh: null, user: null };

export const getSession = () => session;
export const isSignedIn = () => !!session.access;

function setSession(d) {
  session = {
    access: d.access_token || null,
    refresh: d.refresh_token || null,
    user: d.user || null,
  };
  if (d.user && d.user.stores && d.user.stores.length) STORE_ID = d.user.stores[0];
  return session;
}

export function clearSession() {
  session = { access: null, refresh: null, user: null };
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

// A day at the register: by tender, by department, by cashier.
export const getDay = (date) => call('/day' + (date ? '?date=' + date : ''));

// Read a photograph of paper. kind is 'invoice', 'check' or 'statement'.
// It returns a draft to confirm — nothing is saved by this call.
export const readPaper = (kind, base64, mime) =>
  call('/invoice-extract', {
    method: 'POST',
    body: JSON.stringify({ store_id: STORE_ID, kind, base64_image: base64, mime_type: mime }),
  });

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

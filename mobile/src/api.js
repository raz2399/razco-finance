// Every call the app makes. It talks to the same endpoints the dashboard
// does, so a number here can never disagree with a number on the desktop.

import Constants from 'expo-constants';

const BASE =
  (Constants.expoConfig &&
    Constants.expoConfig.extra &&
    Constants.expoConfig.extra.apiBase) ||
  'https://famous-caramel-1cf571.netlify.app/.netlify/functions';

const STORE_ID = 'store1';

async function call(path, options = {}) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}store_id=${encodeURIComponent(STORE_ID)}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch (e) {
    // A dead phone signal and a dead server are different problems and the
    // person should be told which one they have.
    throw new Error('No connection. Check the phone signal and try again.');
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* not json */ }

  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.error) || `The server returned ${res.status}.`);
  }
  return data;
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

export const saveInvoice = (invoice) =>
  call('/invoices', {
    method: 'POST',
    body: JSON.stringify({ store_id: STORE_ID, ...invoice }),
  });

export const getChecks = () => call('/checks');

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

export const STORE = STORE_ID;

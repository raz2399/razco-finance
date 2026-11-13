// Money that left without a bill or a bank line.
//
// ---------------------------------------------------------------------
// The hole this fills
//
// Everything in the system so far starts somewhere else: an invoice he
// photographs, or a line the bank sends. Real spending does neither.
// Cash out of the drawer for ice. The gardener, paid in notes. A payroll
// run that goes out through Fingercheck and shows on the bank as one
// figure with no breakdown. None of it has a bill to scan or, in the
// cash cases, any bank line at all -- so until now it was simply absent
// from the profit figure, which made every week look better than it was.
//
// ---------------------------------------------------------------------
// The two rules that keep it honest
//
// It never settles a bill. Everything written here is settles_ap false:
// a cost in its own right, not a payment against an invoice. Letting it
// pay invoices would mean a figure he typed could close a bill nobody
// had matched, and the two sides of the books would quietly disagree.
//
// Cash and bank money are not the same money. A cash expense never
// pretends to be a bank line -- it carries no bank_txn_id, so the bank
// feed cannot later "settle" it and count the same spending twice. That
// matters most for payroll, which usually DOES arrive on the bank: if he
// records it here and the draft lands tomorrow, the two must not both
// count. So anything paid from the bank is warned about, and the
// matching is left to the bank feed, which is the one that knows.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const dollars = (n) => '$' + money(n).toFixed(2)
  .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// How the money actually left. Only cash and "already drawn" are fully
// his to assert: a card or a transfer will arrive on the bank feed too.
const WAYS = {
  cash: 'Cash',
  check: 'Check',
  card: 'Card',
  transfer: 'Bank transfer',
  other: 'Other',
};

// Paid out of the drawer or a pocket: the bank will never see it, so
// there is nothing to collide with.
const OFF_BANK = { cash: 1, other: 1 };

function pacificToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

exports.handler = safely('spend', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  // ---- what he can file it under, and what he filed lately -----------
  if (event.httpMethod === 'GET') {
    const [cats, recent] = await Promise.all([
      supabase.from('expense_categories')
        .select('category_id, name, ledger_type, department_id')
        .eq('store_id', store_id).eq('active', true).order('name'),
      supabase.from('payments')
        .select('payment_id, payment_date, amount, method, memo, category_id, bank_txn_id')
        .eq('store_id', store_id).is('bank_txn_id', null).eq('settles_ap', false)
        .order('payment_date', { ascending: false }).limit(25),
    ]);
    if (cats.error) return json(500, { error: cats.error.message });

    const byId = {};
    (cats.data || []).forEach((c) => { byId[c.category_id] = c.name; });

    return json(200, {
      ok: true,
      // Overheads first: cash out of the drawer is almost never a
      // department's cost of goods, and a list that opens on "Bakery"
      // invites filing it there.
      categories: (cats.data || [])
        .filter((c) => !c.department_id)
        .map((c) => ({ category_id: c.category_id, name: c.name })),
      cogs_categories: (cats.data || [])
        .filter((c) => c.department_id)
        .map((c) => ({ category_id: c.category_id, name: c.name })),
      ways: Object.keys(WAYS).map((k) => ({ key: k, name: WAYS[k] })),
      today: pacificToday(),
      recent: (recent.data || []).map((p) => ({
        payment_id: p.payment_id,
        date: p.payment_date,
        amount: money(p.amount),
        method: p.method,
        category: byId[p.category_id] || null,
        memo: p.memo || '',
      })),
    });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Use GET or POST.' });
  }

  // ---- taking one back -------------------------------------------------
  if (body.action === 'remove') {
    if (!body.payment_id) return json(400, { error: 'Which one?' });
    // Only ever one he typed: never a bank line, never a bill payment.
    const gone = await supabase.from('payments').delete()
      .eq('payment_id', body.payment_id)
      .eq('store_id', store_id)
      .is('bank_txn_id', null)
      .eq('settles_ap', false)
      .select('payment_id');
    if (gone.error) return json(500, { error: gone.error.message });
    if (!gone.data || !gone.data.length) {
      return json(404, {
        error: 'That is not one of the expenses you typed in, so it was left alone.',
      });
    }
    return json(200, { ok: true, says: 'Taken off.' });
  }

  // ---- writing one down ------------------------------------------------
  const amount = money(body.amount);
  if (!(amount > 0)) {
    return json(400, { error: 'How much was it?' });
  }
  const method = WAYS[body.method] ? body.method : null;
  if (!method) return json(400, { error: 'How was it paid?' });

  const category_id = Number(body.category_id) || null;
  if (!category_id) return json(400, { error: 'What was it for?' });

  const cat = await supabase.from('expense_categories')
    .select('category_id, name').eq('store_id', store_id)
    .eq('category_id', category_id).maybeSingle();
  if (cat.error) return json(500, { error: cat.error.message });
  if (!cat.data) return json(400, { error: 'That is not one of your categories.' });

  const when = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))
    ? body.date : pacificToday();

  // A date in the future is nearly always a typo in the year, and it
  // would sit in the books ahead of everything until that day arrived.
  if (when > pacificToday()) {
    return json(400, { error: 'That date has not happened yet.' });
  }

  const row = {
    store_id: store_id,
    payment_date: when,
    amount: amount,
    method: method,
    // Never a bill. A figure he typed must not be able to close an
    // invoice nobody matched.
    settles_ap: false,
    vendor_id: null,
    bank_txn_id: null,
    category_id: category_id,
    check_number: body.check_number ? String(body.check_number).trim() : null,
    memo: String(body.memo || '').trim() || cat.data.name,
    status: 'cleared',
    created_from_bank: false,
  };

  // Before writing it: is this already on the bank?
  //
  // Payroll is the case that matters. It goes out through Fingercheck
  // and lands on the statement as one figure, so a payroll run typed in
  // here on Friday and drafted on Monday is the same money twice -- and
  // it would make the week look worse by exactly one payroll, which is
  // not a small error. Same amount within five days either way is
  // enough to stop and ask rather than quietly double it.
  if (!OFF_BANK[method] && !body.anyway) {
    const from = new Date(new Date(when + 'T12:00:00Z').getTime() - 5 * 86400000)
      .toISOString().slice(0, 10);
    const to = new Date(new Date(when + 'T12:00:00Z').getTime() + 5 * 86400000)
      .toISOString().slice(0, 10);
    const near = await supabase.from('bank_transactions')
      .select('bank_txn_id, posted_date, description, amount')
      .eq('store_id', store_id)
      .gte('posted_date', from).lte('posted_date', to)
      .lt('amount', 0).limit(400);
    const hit = (near.data || []).filter(
      (t) => money(Math.abs(t.amount)) === amount)[0];
    if (hit) {
      return json(409, {
        error: 'The bank already has ' + dollars(amount) + ' on '
          + hit.posted_date + ' — "' + String(hit.description).slice(0, 48)
          + '". Writing this down too would count the same money twice.',
        duplicate_of: hit.bank_txn_id,
        bank_says: String(hit.description).slice(0, 80),
        bank_date: hit.posted_date,
      });
    }
  }

  const put = await supabase.from('payments').insert(row)
    .select('payment_id').single();
  if (put.error) return json(500, { error: put.error.message });

  // Anything that leaves through the bank will also arrive on the bank
  // feed, and then the same money is on the books twice. The feed is the
  // one that knows, so this says so plainly rather than trying to be
  // clever about which of the two is real.
  const willAlsoLand = !OFF_BANK[method];

  return json(200, {
    ok: true,
    payment_id: put.data.payment_id,
    says: dollars(amount) + ' filed under ' + cat.data.name + '.',
    warn: willAlsoLand
      ? 'Paid from the bank, so this will show on the bank feed too in a '
        + 'day or two. If it does, take one of them off -- otherwise the '
        + 'same money is counted twice.'
      : null,
  });
});

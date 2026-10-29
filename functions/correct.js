// Netlify Function: correct
// When the system is wrong, this is how Raz makes it right.
//
// Route: /.netlify/functions/correct
//   GET  ?store_id=store1                  -> current figures and recent corrections
//   POST { store_id, target, amount, note } -> overwrite a figure
//   POST { store_id, action: "void", kind, id, note } -> undo an entry
//
// target is one of:
//   bank  - the bank balance, when the statement says something else
//   cash  - cash counted in the drawer and the safe
//
// The counted figure replaces the computed one. It is not reconciled, not
// averaged, not argued with: a number a person counted beats a number a
// computer inferred.
//
// Every correction is written down with who, when and why. Overwriting a
// figure without a trace is how books stop being trustworthy — the number
// changes, but the record of the change survives.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');

// The store is in Lindsay, California. Its day ends when the store closes,
// not at 5pm local when UTC rolls into tomorrow -- which is exactly when the
// back office is being worked. Business dates are Pacific; instants
// (created_at and friends) stay UTC, because those are moments, not days.
const BUSINESS_TZ = 'America/Los_Angeles';
const pacificToday = () => new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });


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
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Reading a figure a person typed. "$24,100.50" is fine; "abc" is not, and
// must not quietly become zero — zeroing someone's cash because they fumbled
// the keyboard is the worst thing this endpoint could do.
function readAmount(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return isFinite(raw) ? Math.round(raw * 100) / 100 : null;
  const text = String(raw).trim();
  if (!text) return null;
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
const today = () => pacificToday();

exports.handler = safely('correct', async (event) => {
  // Nobody sees any of this without signing in. Before this, the URL was
  // the only thing between a stranger and the bank position, and a URL is
  // not a secret: it is in browser history, in a chat message, on a screen
  // in a stockroom.
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); }
    catch (e) { return json(400, { error: 'Body is not JSON.' }); }
  }
  const store_id = body.store_id || q.store_id || 'store1';

  try {
    // ---------------- GET: what the system currently thinks ----------------
    if (event.httpMethod === 'GET') {
      const [acctRes, countRes, logRes] = await Promise.all([
        supabase.from('bank_accounts')
          .select('account_id, nickname, last_four, current_balance, balance_as_of')
          .eq('store_id', store_id).eq('active', true).limit(1),
        // created_at alone can tie if two counts land in the same instant,
        // and a tie here means showing the wrong one.
        supabase.from('cash_ledger')
          .select('entry_id, business_date, amount, created_at')
          .eq('store_id', store_id).eq('entry_type', 'count')
          .order('created_at', { ascending: false })
          .order('entry_id', { ascending: false }).limit(1),
        supabase.from('exceptions')
          .select('exception_id, raised_at, code, message, suggested_action')
          .eq('store_id', store_id).eq('code', 'CORRECTION')
          .order('raised_at', { ascending: false }).limit(20),
      ]);

      const acct = (acctRes.data || [])[0] || null;
      const count = (countRes.data || [])[0] || null;

      return json(200, {
        store_id,
        bank: acct ? {
          label: acct.nickname + (acct.last_four ? ' ••' + acct.last_four : ''),
          amount: money(acct.current_balance),
          as_of: acct.balance_as_of,
        } : null,
        cash: count ? {
          amount: money(count.amount),
          as_of: count.business_date,
          counted_at: count.created_at,
        } : null,
        corrections: (logRes.data || []).map((e) => ({
          at: e.raised_at, what: e.message, why: e.suggested_action,
        })),
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Use GET or POST.' });

    // ---------------- POST: undo an entry ----------------
    if (body.action === 'void') {
      const kind = body.kind;
      const id = body.id;
      if (!id) return json(400, { error: 'Which entry?' });

      let before = null;
      if (kind === 'check') {
        const r = await supabase.from('payments')
          .select('check_number, amount, status').eq('payment_id', id).limit(1);
        before = (r.data || [])[0] || null;
        const up = await supabase.from('payments')
          .update({ status: 'void', void_reason: body.note || 'corrected in app' })
          .eq('payment_id', id);
        if (up.error) return json(500, { error: 'Could not void the check: ' + up.error.message });
      } else if (kind === 'invoice') {
        const r = await supabase.from('invoices')
          .select('invoice_number, total_amount, status').eq('invoice_id', id).limit(1);
        before = (r.data || [])[0] || null;
        // balance_due is generated, so status alone retires the invoice.
        const up = await supabase.from('invoices')
          .update({ status: 'void', notes: body.note || 'corrected in app' })
          .eq('invoice_id', id);
        if (up.error) return json(500, { error: 'Could not void the invoice: ' + up.error.message });
      } else if (kind === 'bank_txn') {
        const up = await supabase.from('bank_transactions')
          .update({ match_status: 'unmatched', matched_type: null, matched_id: null })
          .eq('bank_txn_id', id);
        if (up.error) return json(500, { error: 'Could not unmatch it: ' + up.error.message });
      } else {
        return json(400, { error: 'That is not something this can undo.' });
      }

      await supabase.from('exceptions').insert({
        store_id,
        raised_by: 'correction',
        severity: 'info',
        code: 'CORRECTION',
        entity_type: kind,
        entity_id: kind === 'bank_txn' ? id : null,
        message: 'Voided a ' + kind + (before && before.check_number ? ' (#' + before.check_number + ')' : ''),
        suggested_action: body.note || 'No reason given',
        status: 'resolved',
      });

      return json(200, { ok: true, voided: kind, id, before });
    }

    // ---------------- POST: overwrite a figure ----------------
    const target = body.target;
    if (target !== 'bank' && target !== 'cash') {
      return json(400, { error: 'Correct either the bank balance or the cash on hand.' });
    }
    if (body.amount === undefined || body.amount === null || body.amount === '') {
      return json(400, { error: 'What is the correct figure?' });
    }
    const amount = readAmount(body.amount);
    if (amount === null) {
      return json(400, { error: 'That is not a number I can read: "' + body.amount + '".' });
    }
    if (amount < 0 && target === 'cash') {
      return json(400, { error: 'Cash on hand cannot be negative.' });
    }

    const when = body.business_date || today();
    const note = (body.note || '').trim();

    if (target === 'bank') {
      const acctRes = await supabase.from('bank_accounts')
        .select('account_id, current_balance')
        .eq('store_id', store_id).eq('active', true).limit(1);
      const acct = (acctRes.data || [])[0];
      if (!acct) return json(404, { error: 'There is no bank account on file to correct.' });

      const was = money(acct.current_balance);
      const up = await supabase.from('bank_accounts')
        .update({ current_balance: amount, balance_as_of: when })
        .eq('account_id', acct.account_id);
      if (up.error) return json(500, { error: 'Could not save it: ' + up.error.message });

      await supabase.from('exceptions').insert({
        store_id, raised_by: 'correction', severity: 'info', code: 'CORRECTION',
        entity_type: 'bank_account', entity_id: acct.account_id,
        message: 'Bank balance corrected from $' + was.toFixed(2) + ' to $' + amount.toFixed(2),
        suggested_action: note || 'No reason given',
        status: 'resolved',
      });

      return json(200, { ok: true, target, was, now: amount, as_of: when, note });
    }

    // cash counted in the drawer and the safe
    const prevRes = await supabase.from('cash_ledger')
      .select('amount, entry_id').eq('store_id', store_id).eq('entry_type', 'count')
      .order('created_at', { ascending: false })
      .order('entry_id', { ascending: false }).limit(1);
    const was = (prevRes.data || [])[0] ? money(prevRes.data[0].amount) : null;

    const ins = await supabase.from('cash_ledger').insert({
      store_id,
      business_date: when,
      entry_type: 'count',
      amount,
    });
    if (ins.error) return json(500, { error: 'Could not save the count: ' + ins.error.message });

    await supabase.from('exceptions').insert({
      store_id, raised_by: 'correction', severity: 'info', code: 'CORRECTION',
      entity_type: 'cash_ledger',
      message: 'Cash on hand counted at $' + amount.toFixed(2) +
               (was === null ? '' : ' (was $' + was.toFixed(2) + ')'),
      suggested_action: note || 'No reason given',
      status: 'resolved',
    });

    return json(200, { ok: true, target, was, now: amount, as_of: when, note });
  } catch (err) {
    return json(500, { error: err.message, where: 'correct' });
  }
});

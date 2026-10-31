// Netlify Function: vendor-setup
// The two facts about a vendor that only Raz knows, and the list of who
// is still missing them.
//
// Route: /.netlify/functions/vendor-setup
//   GET  ?store_id=store1
//        -> the categories, who has no category, who has no terms
//   POST { vendor_id, default_category_id?, terms_code?, terms_days? }
//
// ---------------------------------------------------------------------
// Why this is a screen and not a script
//
// A vendor's category can be guessed from its name often enough to be
// tempting -- "GREEN VALLEY PRODUCE" is clearly merchandise. 184 of the
// 255 were set that way, because those names say what they sell.
//
// The remaining 71 are mostly people's names, and a person's name tells
// you nothing: Juan Martinez could be a day labourer or a one-man produce
// supplier, and those are different lines on a P&L. Terms are worse --
// they are a commercial agreement between two people and appear nowhere
// in any data this system holds.
//
// So both are asked rather than inferred, and the lists are ordered by
// money, because the point is not to finish the list. It is to get the
// handful that matter set, and the rest can wait for the next invoice.

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

// The terms a grocery supplier actually offers. 'cod' is here because a
// lot of Razco's smaller vendors are paid on delivery, and calling that
// "net 0" would be technically right and completely unreadable.
const TERMS = {
  cod: 0, net7: 7, net10: 10, net14: 14, net15: 15,
  net21: 21, net30: 30, net45: 45, net60: 60,
  eom: null, prox10: null, weekly: 7,
};

async function all(table, columns, build) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns).range(from, from + PAGE - 1);
    q = build(q);
    const res = await q;
    if (res.error) throw new Error(table + ': ' + res.error.message);
    const got = res.data || [];
    rows.push.apply(rows, got);
    if (got.length < PAGE) return rows;
    if (rows.length > 100000) return rows;
  }
}

exports.handler = safely('vendor-setup', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { body = {}; }
  }
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  // ---------------- a new vendor ---------------------------------------
  //
  // Until now a vendor could only appear by being imported. Everything
  // else -- an invoice, a check, a bank rule -- needs one to point at,
  // so a vendor nobody can create is a dead end at the moment a new
  // supplier turns up at the door.
  if (event.httpMethod === 'POST' && body.action === 'create') {
    const name = String(body.name || '').trim();
    if (name.length < 2) return json(400, { error: 'What is the vendor called?' });

    // The same supplier typed slightly differently is how a vendor list
    // becomes 255 rows with four spellings of Sysco in it. Compared on
    // letters and digits only, so "Tony's Fine Foods" and "TONYS FINE
    // FOODS" are seen as the one supplier they are.
    const squash = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const existing = await all('vendors', 'vendor_id, name, active',
      (p) => p.eq('store_id', store_id));
    const clash = existing.filter((v) => squash(v.name) === squash(name))[0];
    if (clash && !body.anyway) {
      return json(409, {
        error: '"' + clash.name + '" is already on the list'
          + (clash.active === false ? ', though it is switched off' : '') + '.',
        vendor_id: clash.vendor_id,
        ask: 'Send it again with anyway to add a second one.',
      });
    }

    const row = {
      store_id: store_id,
      name: name,
      payment_type: body.payment_type || 'unknown',
      active: true,
    };
    if (body.default_category_id) row.default_category_id = Number(body.default_category_id);
    if (body.terms_code && Object.prototype.hasOwnProperty.call(TERMS, body.terms_code)) {
      row.terms_code = body.terms_code;
      row.terms_days = TERMS[body.terms_code];
    }
    ['address_line1', 'address_line2', 'city', 'state', 'postal_code',
      'contact_phone', 'account_number'].forEach((k) => {
      if (body[k]) row[k] = String(body[k]).trim();
    });

    const ins = await supabase.from('vendors').insert(row)
      .select('vendor_id, name, default_category_id, terms_code, terms_days').single();
    if (ins.error) return json(500, { error: ins.error.message });

    return json(200, {
      ok: true,
      vendor: ins.data,
      message: ins.data.name + ' added.',
    });
  }

  // ---------------- removing a vendor ----------------------------------
  //
  // A vendor with history is switched off, never deleted. Deleting one
  // would orphan every invoice and check that points at it, and a
  // ledger line whose payee has vanished is worse than useless at the
  // moment somebody is trying to work out what was paid.
  //
  // A vendor added by mistake five minutes ago, with nothing against
  // it, is simply deleted.
  if (event.httpMethod === 'POST' && body.action === 'remove') {
    const vendor_id = body.vendor_id;
    if (!vendor_id) return json(400, { error: 'Which vendor?' });

    const v = await supabase.from('vendors')
      .select('vendor_id, name, active')
      .eq('vendor_id', vendor_id).eq('store_id', store_id).maybeSingle();
    if (v.error) return json(500, { error: v.error.message });
    if (!v.data) return json(404, { error: 'No such vendor.' });

    const [inv, pay, rules, bank] = await Promise.all([
      supabase.from('invoices').select('invoice_id').eq('vendor_id', vendor_id).limit(1),
      supabase.from('payments').select('payment_id').eq('vendor_id', vendor_id).limit(1),
      supabase.from('bank_rules').select('rule_id').eq('vendor_id', vendor_id).limit(1),
      supabase.from('bank_transactions').select('bank_txn_id').eq('vendor_id', vendor_id).limit(1),
    ]);
    const history = ((inv.data || []).length ? 1 : 0) + ((pay.data || []).length ? 1 : 0)
      + ((rules.data || []).length ? 1 : 0) + ((bank.data || []).length ? 1 : 0);

    if (history) {
      const off = await supabase.from('vendors')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('vendor_id', vendor_id).eq('store_id', store_id);
      if (off.error) return json(500, { error: off.error.message });
      return json(200, {
        ok: true,
        switched_off: true,
        message: v.data.name + ' has bills or checks against it, so it is switched '
          + 'off rather than deleted. It stops appearing when you add things, and '
          + 'everything already on the books still says who it was to.',
      });
    }

    const del = await supabase.from('vendors').delete()
      .eq('vendor_id', vendor_id).eq('store_id', store_id);
    if (del.error) return json(500, { error: del.error.message });
    return json(200, {
      ok: true,
      deleted: true,
      message: v.data.name + ' deleted. Nothing was against it.',
    });
  }

  // ---------------- set one ------------------------------------------
  if (event.httpMethod === 'POST') {
    const vendor_id = body.vendor_id;
    if (!vendor_id) return json(400, { error: 'Which vendor?' });

    const patch = {};

    if (body.default_category_id !== undefined) {
      if (body.default_category_id === null || body.default_category_id === '') {
        patch.default_category_id = null;
      } else {
        const cat = Number(body.default_category_id);
        if (!cat) return json(400, { error: 'That is not a category.' });
        // Checked against the real table rather than trusted, so a stale
        // dropdown cannot write a category that does not exist.
        const ok = await supabase
          .from('expense_categories')
          .select('category_id')
          .eq('store_id', store_id)
          .eq('category_id', cat)
          .maybeSingle();
        if (ok.error) return json(500, { error: ok.error.message });
        if (!ok.data) return json(400, { error: 'No such category.' });
        patch.default_category_id = cat;
      }
    }

    if (body.terms_code !== undefined) {
      const code = body.terms_code === null || body.terms_code === ''
        ? null : String(body.terms_code).toLowerCase();
      if (code !== null && !Object.prototype.hasOwnProperty.call(TERMS, code)) {
        return json(400, {
          error: 'Terms have to be one of: ' + Object.keys(TERMS).join(', ') + '.',
        });
      }
      patch.terms_code = code;
      // Days come from the code unless he gave a number himself. A code
      // without days would leave the due date uncomputable, which is the
      // problem this screen exists to fix.
      if (body.terms_days !== undefined && body.terms_days !== null && body.terms_days !== '') {
        const d = Number(body.terms_days);
        if (isNaN(d) || d < 0 || d > 365) return json(400, { error: 'Days has to be 0 to 365.' });
        patch.terms_days = d;
      } else {
        patch.terms_days = code === null ? null : TERMS[code];
      }
    } else if (body.terms_days !== undefined) {
      const d = Number(body.terms_days);
      if (isNaN(d) || d < 0 || d > 365) return json(400, { error: 'Days has to be 0 to 365.' });
      patch.terms_days = d;
    }

    if (body.terms_note !== undefined) patch.terms_note = body.terms_note || null;

    if (!Object.keys(patch).length) return json(400, { error: 'Nothing to change.' });
    patch.updated_at = new Date().toISOString();

    const res = await supabase
      .from('vendors')
      .update(patch)
      .eq('vendor_id', vendor_id)
      .eq('store_id', store_id)
      .select('vendor_id, name, default_category_id, terms_code, terms_days');
    if (res.error) return json(500, { error: res.error.message });
    const row = (res.data || [])[0];
    if (!row) return json(404, { error: 'No such vendor.' });

    // Setting a category is only half the job if the bills already on
    // file are still blank, so they are filled in the same breath.
    let coded = 0;
    if (patch.default_category_id) {
      const back = await supabase
        .from('invoices')
        .update({ category_id: patch.default_category_id })
        .eq('store_id', store_id)
        .eq('vendor_id', vendor_id)
        .is('category_id', null)
        .select('invoice_id');
      if (!back.error) coded = (back.data || []).length;
    }

    return json(200, {
      ok: true,
      vendor: row,
      invoices_coded: coded,
      message: row.name + ' saved.'
        + (coded ? ' ' + coded + ' bill' + (coded === 1 ? '' : 's')
            + ' already on file took the same category.' : ''),
    });
  }

  // ---------------- who still needs what ------------------------------
  const [vendors, invoices, cats] = await Promise.all([
    all('vendors',
      'vendor_id, name, default_category_id, terms_code, terms_days, payment_type, active',
      (p) => p.eq('store_id', store_id).eq('active', true)),
    all('invoices', 'vendor_id, total_amount, balance_due, status',
      (p) => p.eq('store_id', store_id)),
    all('expense_categories', 'category_id, name, ledger_type',
      (p) => p.eq('store_id', store_id).eq('active', true)),
  ]);

  // How much each vendor is worth, two ways: everything ever billed
  // (which ranks the category list) and what is open right now (which
  // ranks the terms list, because terms only matter on unpaid bills).
  const spend = {};
  const open = {};
  invoices.forEach((i) => {
    if (!i.vendor_id) return;
    if (i.status !== 'void') {
      spend[i.vendor_id] = money((spend[i.vendor_id] || 0) + Math.abs(money(i.total_amount)));
    }
    if (i.status !== 'void' && i.status !== 'paid') {
      open[i.vendor_id] = money((open[i.vendor_id] || 0) + Math.abs(money(i.balance_due)));
    }
  });

  const needCategory = vendors
    .filter((v) => !v.default_category_id)
    .map((v) => ({
      vendor_id: v.vendor_id, name: v.name,
      billed: spend[v.vendor_id] || 0, open: open[v.vendor_id] || 0,
    }))
    .sort((a, b) => (b.billed - a.billed) || a.name.localeCompare(b.name));

  const needTerms = vendors
    .filter((v) => v.terms_days === null || v.terms_days === undefined)
    .map((v) => ({
      vendor_id: v.vendor_id, name: v.name, payment_type: v.payment_type,
      billed: spend[v.vendor_id] || 0, open: open[v.vendor_id] || 0,
    }))
    .sort((a, b) => (b.open - a.open) || (b.billed - a.billed) || a.name.localeCompare(b.name));

  return json(200, {
    ok: true,
    categories: cats,
    terms_options: Object.keys(TERMS),
    counts: {
      vendors: vendors.length,
      need_category: needCategory.length,
      need_terms: needTerms.length,
      // Said out loud because it is the number that decides whether the
      // list is worth opening: most of these vendors have no open bills.
      need_terms_with_open_bills: needTerms.filter((v) => v.open > 0).length,
    },
    need_category: needCategory,
    need_terms: needTerms,
  });
});

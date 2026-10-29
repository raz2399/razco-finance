// Netlify Function: invoice-extract
// Reads a photograph of a vendor invoice and returns what it says.
//
// Route: /.netlify/functions/invoice-extract
//   POST { store_id, base64_image, mime_type }
//
// It READS ONLY. It does not create the invoice, on purpose: saving goes
// through /invoices, which knows about the four payment methods, terms,
// due dates and vendor memory. An extractor that wrote its own rows would
// produce invoices with no payment method and no due date, which is exactly
// the paperwork problem this is meant to end.
//
// What comes back is a draft for Raz to glance at and confirm. A number read
// off a photograph is never treated as a fact.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MODEL = process.env.EXTRACT_MODEL || 'claude-sonnet-5-5';
const MAX_BYTES = 6 * 1024 * 1024; // a phone photo, not a scan of a book

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const PROMPTS = {
  invoice: `You are reading a photograph of a grocery wholesaler's delivery invoice.

Return ONLY a JSON object, no markdown, no commentary:

{
  "vendor_name": string | null,
  "invoice_number": string | null,
  "invoice_date": "YYYY-MM-DD" | null,
  "subtotal": number | null,
  "tax": number | null,
  "freight": number | null,
  "total": number | null,
  "terms_text": string | null,
  "line_count": number | null,
  "unreadable": string[]
}

Rules:
- "total" is the amount payable — the invoice total, after tax and freight.
  If a credit memo makes it negative, report it negative.
- Never guess. If a field is not legible in the photograph, use null and add
  a short note to "unreadable" saying which field and why (blurred, cut off,
  covered). A wrong number here becomes a wrong number in someone's books.
- "terms_text" is whatever the invoice literally says about payment terms
  ("NET 14", "COD", "2% 10 NET 30"). Do not translate or interpret it.
- Dates: if the year is not shown, use null rather than assuming.
- Numbers: digits only, no currency symbols, no thousands separators.`,

  check: `You are reading a photograph of a business check, or its stub, that
the store has written to a vendor.

Return ONLY a JSON object, no markdown, no commentary:

{
  "check_number": string | null,
  "payee": string | null,
  "amount": number | null,
  "check_date": "YYYY-MM-DD" | null,
  "memo": string | null,
  "handwritten": boolean,
  "unreadable": string[]
}

Rules:
- "amount" is the figure the check is written for. If the numeric box and the
  written line disagree, report null and say so in "unreadable" — a check
  whose two amounts differ is a problem a person must look at.
- Set "handwritten" true if the amount or payee is handwritten rather than
  printed, because handwriting is read less reliably and the person should
  check it.
- Never guess at a digit. A wrong check number means the bank match goes to
  the wrong check later.
- Numbers: digits only, no currency symbols, no thousands separators.`,

  statement: `You are reading a photograph or scan of a bank statement page.

Return ONLY a JSON object, no markdown, no commentary:

{
  "account_last_four": string | null,
  "statement_date": "YYYY-MM-DD" | null,
  "ending_balance": number | null,
  "transactions": [
    { "date": "YYYY-MM-DD" | null,
      "description": string,
      "amount": number,
      "check_number": string | null }
  ],
  "unreadable": string[]
}

Rules:
- Money leaving the account is negative. Money arriving is positive.
- "check_number" only when the line clearly refers to a check.
- Only include a transaction whose amount you can read exactly. Anything
  partly legible goes in "unreadable" instead, described well enough that a
  person can find that line on the page.
- Do not total anything yourself. Report what is printed.
- Numbers: digits only, no currency symbols, no thousands separators.`,
};

exports.handler = safely('invoice-extract', async (event) => {
  // Nobody sees any of this without signing in. Before this, the URL was
  // the only thing between a stranger and the bank position, and a URL is
  // not a secret: it is in browser history, in a chat message, on a screen
  // in a stockroom.
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only.' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: 'No ANTHROPIC_API_KEY is configured on the site.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Body is not JSON.' }); }

  const { base64_image, mime_type } = body;
  const store_id = body.store_id || 'store1';
  const kind = PROMPTS[body.kind] ? body.kind : 'invoice';

  if (!base64_image) return json(400, { error: 'No photo was sent.' });
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime_type || '')) {
    return json(400, { error: 'That file type cannot be read. Use a photo (JPEG or PNG).' });
  }
  if (base64_image.length * 0.75 > MAX_BYTES) {
    return json(413, { error: 'That photo is too large. Take it again at normal quality.' });
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime_type, data: base64_image } },
            { type: 'text', text: PROMPTS[kind] },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return json(502, {
        error: 'Could not read the photo right now.',
        detail: detail.slice(0, 300),
      });
    }

    const payload = await res.json();
    const text = (payload.content || [])
      .filter((c) => c.type === 'text').map((c) => c.text).join('');

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return json(502, { error: 'The photo could not be turned into invoice fields.' });
      try { data = JSON.parse(m[0]); }
      catch (e2) { return json(502, { error: 'The photo could not be turned into invoice fields.' }); }
    }

    const num = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
      return isNaN(n) ? null : Math.round(n * 100) / 100;
    };
    const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
    const notes = Array.isArray(data.unreadable) ? data.unreadable.slice() : [];

    // ---------------- a check the store wrote ----------------
    if (kind === 'check') {
      const draft = {
        check_number: data.check_number ? String(data.check_number).replace(/\D/g, '') || null : null,
        payee: data.payee || null,
        amount: num(data.amount),
        check_date: isoDate(data.check_date),
        memo: data.memo || null,
        handwritten: data.handwritten === true,
        unreadable: notes,
      };

      // Is this check already logged? Writing it twice doubles what is out.
      let duplicate = null;
      if (draft.check_number) {
        const d = await supabase
          .from('payments')
          .select('payment_id, check_number, amount, payment_date, status')
          .eq('store_id', store_id)
          .eq('method', 'check')
          .eq('check_number', Number(draft.check_number))
          .neq('status', 'void')
          .limit(1);
        duplicate = (d.data || [])[0] || null;
      }

      if (draft.handwritten) {
        notes.push('The amount is handwritten. Check it against the check before saving.');
      }

      return json(200, {
        ok: true, kind, draft, duplicate,
        needs_eyes: draft.amount === null || draft.check_number === null ||
                    notes.length > 0 || !!duplicate,
        model: MODEL,
      });
    }

    // ---------------- a page of a bank statement ----------------
    if (kind === 'statement') {
      const rows = Array.isArray(data.transactions) ? data.transactions : [];
      const transactions = rows
        .map((t) => ({
          date: isoDate(t.date),
          description: String(t.description || '').trim(),
          amount: num(t.amount),
          check_number: t.check_number ? String(t.check_number).replace(/\D/g, '') || null : null,
        }))
        .filter((t) => t.amount !== null && t.description);

      const dropped = rows.length - transactions.length;
      if (dropped > 0) {
        notes.push(dropped + ' line' + (dropped === 1 ? '' : 's') +
                   ' could not be read well enough to use.');
      }

      return json(200, {
        ok: true, kind,
        draft: {
          account_last_four: data.account_last_four || null,
          statement_date: isoDate(data.statement_date),
          ending_balance: num(data.ending_balance),
          transactions,
          unreadable: notes,
        },
        // A photographed statement is for a quick look or a small page. A full
        // month still belongs in the CSV import, which reads every line exactly.
        needs_eyes: true,
        advice: transactions.length > 25
          ? 'That is a lot of lines from a photograph. Import the CSV instead so nothing is missed.'
          : null,
        model: MODEL,
      });
    }

    // ---------------- a vendor invoice ----------------
    const draft = {
      vendor_name: data.vendor_name || null,
      invoice_number: data.invoice_number ? String(data.invoice_number).trim() : null,
      invoice_date: isoDate(data.invoice_date),
      subtotal: num(data.subtotal),
      tax: num(data.tax),
      freight: num(data.freight),
      total: num(data.total),
      terms_text: data.terms_text || null,
      line_count: Number.isFinite(data.line_count) ? data.line_count : null,
      unreadable: notes,
    };

    // Does the arithmetic on the page agree with itself? If it does not, say
    // so rather than quietly trusting the total.
    if (draft.total !== null && draft.subtotal !== null) {
      const summed = [draft.subtotal, draft.tax, draft.freight]
        .reduce((acc, v) => acc + (v || 0), 0);
      if (Math.abs(summed - draft.total) > 0.02) {
        notes.push(
          'The parts add up to ' + summed.toFixed(2) + ' but the total reads ' +
          draft.total.toFixed(2) + '. Check the total before saving.'
        );
      }
    }

    let vendor = null;
    let duplicate = null;

    if (draft.vendor_name) {
      const v = await supabase
        .from('vendors')
        .select('vendor_id, name, payment_type, terms_code, terms_days')
        .eq('store_id', store_id)
        .ilike('name', '%' + draft.vendor_name.replace(/[%_]/g, '') + '%')
        .limit(1);
      vendor = (v.data || [])[0] || null;
    }

    if (draft.invoice_number && vendor) {
      const d = await supabase
        .from('invoices')
        .select('invoice_id, invoice_date, total_amount, status')
        .eq('store_id', store_id)
        .eq('vendor_id', vendor.vendor_id)
        .eq('invoice_number', draft.invoice_number)
        .neq('status', 'void')
        .limit(1);
      duplicate = (d.data || [])[0] || null;
    }

    return json(200, {
      ok: true,
      kind,
      draft,
      vendor: vendor ? {
        vendor_id: vendor.vendor_id,
        name: vendor.name,
        pay_method: vendor.payment_type,
        terms_code: vendor.terms_code,
        terms_days: vendor.terms_days,
        known: true,
      } : { known: false },
      duplicate,
      needs_eyes: draft.total === null || notes.length > 0 || !!duplicate,
      model: MODEL,
    });
  } catch (err) {
    return json(500, { error: err.message, where: 'invoice-extract' });
  }
});

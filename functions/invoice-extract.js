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

const PROMPT = `You are reading a photograph of a grocery wholesaler's delivery invoice.

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
- Numbers: digits only, no currency symbols, no thousands separators.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only.' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: 'No ANTHROPIC_API_KEY is configured on the site.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Body is not JSON.' }); }

  const { base64_image, mime_type } = body;
  const store_id = body.store_id || 'store1';

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
            { type: 'text', text: PROMPT },
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

    const draft = {
      vendor_name: data.vendor_name || null,
      invoice_number: data.invoice_number ? String(data.invoice_number).trim() : null,
      invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(data.invoice_date || '') ? data.invoice_date : null,
      subtotal: num(data.subtotal),
      tax: num(data.tax),
      freight: num(data.freight),
      total: num(data.total),
      terms_text: data.terms_text || null,
      line_count: Number.isFinite(data.line_count) ? data.line_count : null,
      unreadable: Array.isArray(data.unreadable) ? data.unreadable : [],
    };

    // Does the arithmetic on the page agree with itself? If it does not, say
    // so rather than quietly trusting the total.
    const parts = [draft.subtotal, draft.tax, draft.freight];
    if (draft.total !== null && draft.subtotal !== null) {
      const summed = parts.reduce((s, v) => s + (v || 0), 0);
      if (Math.abs(summed - draft.total) > 0.02) {
        draft.unreadable.push(
          'The parts add up to ' + summed.toFixed(2) + ' but the total reads ' +
          draft.total.toFixed(2) + '. Check the total before saving.'
        );
      }
    }

    // Is this a vendor we already know, and do we already have this invoice?
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
      draft,
      // When the vendor is known, their payment method and terms are already
      // on file, so Raz confirms rather than re-enters them.
      vendor: vendor ? {
        vendor_id: vendor.vendor_id,
        name: vendor.name,
        pay_method: vendor.payment_type,
        terms_code: vendor.terms_code,
        terms_days: vendor.terms_days,
        known: true,
      } : { known: false },
      duplicate,
      needs_eyes: draft.total === null || draft.unreadable.length > 0 || !!duplicate,
      model: MODEL,
    });
  } catch (err) {
    return json(500, { error: err.message, where: 'invoice-extract' });
  }
};

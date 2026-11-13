// What the reader is asked, and how its answer is read back.
//
// Shared because the same prompt now serves two callers: the quick
// function that answers the phone, and the background one that does the
// actual reading with no clock on it. Two copies of a prompt is two
// prompts, and they drift.

const MODEL = process.env.EXTRACT_MODEL || 'claude-sonnet-5-5';

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

  check: `You are reading a photograph of a business check, or its stub,
that the store has written to a vendor.

Return ONLY a JSON object, no markdown, no commentary:

{
  "is_stub": boolean,
  "check_number": string | null,
  "payee": string | null,
  "amount_numeric": number | null,
  "amount_written": string | null,
  "check_date": "YYYY-MM-DD" | null,
  "memo": string | null,
  "handwritten": boolean,
  "unreadable": string[]
}

Rules:
- "amount_numeric" is what the numeric box says. "amount_written" is the
  words on the long line, copied as you read them, e.g. "One Thousand Two
  Hundred Thirty-Four and 50/100". Report each one from what you can
  actually see and DO NOT make them agree. If only one is present --
  a stub usually has only the figure -- the other is null.
- Do not decide whether the two amounts match. Report both and let the
  system compare them.
- "is_stub" is true when this is a carbon copy, register page or stub
  rather than the check itself.
- Set "handwritten" true if the amount or payee is handwritten rather than
  printed.
- Never guess at a digit. A wrong check number means the bank match goes to
  the wrong check later. Put anything you could not read in "unreadable".
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


/**
 * The model is asked for bare JSON and nearly always gives it. Nearly.
 * Sometimes it arrives wrapped in a fence or with a line of preamble, so
 * the first outermost object is dug out rather than the whole reply
 * being thrown away over a stray backtick.
 */
function parseModelJson(text) {
  const raw = String(text || '');
  try { return JSON.parse(raw); } catch (e) { /* keep looking */ }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (e) { /* keep looking */ }
  }

  const braced = raw.match(/\{[\s\S]*\}/);
  if (braced) {
    try { return JSON.parse(braced[0]); } catch (e) { /* out of ideas */ }
  }
  return null;
}

// How many tokens the reader may spend on one answer. Enough for a long
// delivery invoice with every line on it.
const MAX_TOKENS = 4096;

/**
 * Show the model one photograph and get the fields back.
 *
 * This lives here rather than in the background function because the
 * fallback path needs exactly the same reader. When the bucket cannot
 * take the photograph there is no file to fetch later, so the reading
 * has to happen there and then -- and it must be the same prompts, the
 * same model and the same parsing, or the rare path would quietly be a
 * worse reader than the normal one and nobody would ever notice.
 */
async function askTheModel(base64, mime, kind, extraNote) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
    { type: 'text', text: PROMPTS[kind] + (extraNote ? '\n\n' + extraNote : '') },
  ];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error('The reader refused the photo.');
    err.detail = detail.slice(0, 400);
    err.status = res.status;
    throw err;
  }

  const payload = await res.json();
  const text = (payload.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  return parseModelJson(text);
}

// What to tell the reader when the first pass came back with nothing.
//
// Aimed squarely at the invoices he has been typing in by hand: a photo
// at an angle, a carbon copy, a total written on in biro. Shared so the
// background reader and the fallback reader say exactly the same thing.
const SECOND_LOOK =
  'A first pass found almost nothing on this photograph. Look again, '
  + 'carefully, and assume it IS readable. It may be creased, at an '
  + 'angle, a carbon copy, lit badly, or part covered by a thumb. The '
  + 'total may be handwritten beside or instead of the printed one -- '
  + 'if a figure is written on by hand, that is the amount payable and '
  + 'the printed one is not. The vendor may only appear in small print '
  + 'in a header, a footer, a remit-to block, or a logo. Give every '
  + 'field you can make out, and list only what truly cannot be read.';

/** Did that read actually tell us anything? */
function tooThin(kind, data) {
  if (!data) return true;
  if (kind === 'check') {
    return data.amount_numeric == null && data.amount_written == null;
  }
  if (kind === 'statement') return !data.lines || !data.lines.length;
  return !data.vendor_name && data.total == null;
}

module.exports = {
  PROMPTS, MODEL, MAX_TOKENS, SECOND_LOOK, parseModelJson, askTheModel, tooThin,
};

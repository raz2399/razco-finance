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

module.exports = { PROMPTS, MODEL, parseModelJson };

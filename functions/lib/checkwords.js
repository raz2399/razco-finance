// The amount, written out, the way a bank reads it.
//
// ---------------------------------------------------------------------
// Why this is its own file with its own tests
//
// On a check the written line is the LEGAL amount. Where the numeric box
// and the written line disagree, US banks follow the written line (UCC
// 3-114). So a bug here does not produce a wrong-looking check -- it
// produces a check that pays the wrong amount, correctly, and the bank
// is right to do it.
//
// The failures that matter are quiet ones:
//
//   1234.5   must be "...and 50/100", never "and 5/100"
//   1000000  must not come out "One Million" with a missing "and 00/100"
//   0.99     must be "Zero and 99/100", not "and 99/100"
//   1234.567 must not round up past what the numeric box says
//
// ---------------------------------------------------------------------
// The filler
//
// Everything after the words is filled with asterisks to the end of the
// line, so nobody can write " THOUSAND" into the gap after "Four
// Hundred". Same for the numeric box. This is why checks look like that.

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
  'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
  'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty',
  'Seventy', 'Eighty', 'Ninety'];
// Nothing above a trillion: a grocery store does not write that check,
// and a number that large is a mistake worth refusing rather than
// printing.
const SCALE = ['', ' Thousand', ' Million', ' Billion'];

function underThousand(n) {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const o = n % 10;
    return o ? t + '-' + ONES[o] : t;
  }
  const h = ONES[Math.floor(n / 100)] + ' Hundred';
  const rest = n % 100;
  return rest ? h + ' ' + underThousand(rest) : h;
}

/**
 * The whole-dollar part, in words. 0 is "Zero" -- a check for 0.99 still
 * has to say something before "and 99/100".
 */
function dollarsInWords(dollars) {
  if (dollars === 0) return 'Zero';
  const parts = [];
  let n = dollars;
  let scale = 0;
  while (n > 0) {
    const chunk = n % 1000;
    if (chunk) parts.unshift(underThousand(chunk) + SCALE[scale]);
    n = Math.floor(n / 1000);
    scale += 1;
    if (scale >= SCALE.length && n > 0) return null;  // too large to write
  }
  return parts.join(' ');
}

/**
 * The full written line.
 *
 * Returns null for anything that must not be printed -- negative, not a
 * number, or larger than the words can express. A caller that gets null
 * must refuse to print the check rather than fall back to the figure.
 */
function amountInWords(amount) {
  const n = Number(amount);
  if (!isFinite(n) || n < 0) return null;

  // Rounded to the cent FIRST, once, so the words and the numeric box
  // are computed from the same number. Deriving them separately is how
  // they come to disagree by a cent.
  const cents = Math.round(n * 100);
  if (cents > 999999999999) return null;

  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;

  const words = dollarsInWords(dollars);
  if (words === null) return null;

  // Always two digits. "and 5/100" would be read as five cents on a
  // fifty-cent check.
  const pad = remainder < 10 ? '0' + remainder : String(remainder);
  return words + ' and ' + pad + '/100';
}

/**
 * The same amount as the numeric box, from the same rounding, with the
 * leading and trailing protection a printed check carries.
 */
function amountInFigures(amount) {
  const n = Number(amount);
  if (!isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  const whole = Math.floor(cents / 100);
  const rem = cents % 100;
  let out = '';
  const s = String(whole);
  for (let i = 0; i < s.length; i++) {
    out += s.charAt(i);
    const left = s.length - 1 - i;
    if (left > 0 && left % 3 === 0) out += ',';
  }
  return '**' + out + '.' + (rem < 10 ? '0' + rem : String(rem));
}

/**
 * Pads the written line out to the width of the line so the gap after it
 * cannot be written in.
 */
function fill(text, width) {
  const w = width || 90;
  if (text.length >= w) return text;
  let out = text + ' ';
  while (out.length < w) out += '*';
  return out;
}

module.exports = { amountInWords, amountInFigures, dollarsInWords, fill };

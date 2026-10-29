// Reading numbers and dates off paper that other people's software wrote.
//
// These three started life inside bank-import.js, where they were worked
// out against real Bank of the Sierra exports. The vendor-sheet reader needs
// exactly the same three, and a second copy of a date parser is how two
// readers quietly start disagreeing about what 09/14/26 means.
//
// A note on what these DON'T do: none of them guess. toAmount on something
// that is not a number returns NaN, and toDate on something that is not a
// date returns null, rather than today, or zero, or a best effort. The
// caller is then forced to decide what to do with a cell it could not read,
// which is the only safe place for that decision to be made.

// Splits one CSV line, respecting quotes, because a vendor name with a
// comma in it ("M & J Seafood Co., Inc.") is one field, not two.
function splitLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim().replace(/^["']|["']$/g, ''));
}

// Tab-separated, for a sheet pasted straight out of Excel. Pasting is how
// this will actually be used half the time, and Excel puts tabs on the
// clipboard, not commas.
function splitTabLine(line) {
  return String(line).split('\t').map((c) => c.trim().replace(/^["']|["']$/g, ''));
}

// Accounting writes a negative as (1,234.56). Losing the parentheses turns
// a credit into a charge, so they are read before they are stripped.
function toAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  const paren = /^\(.*\)$/.test(s);
  s = s.replace(/[()$\s,]/g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return paren ? -n : n;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                 jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Returns YYYY-MM-DD, or null if this is not a date.
//
// US order throughout: 09/14/2026 is September the 14th. Everything this
// reads -- QuickBooks, Bank of the Sierra, a vendor statement printed in
// Tulare County -- writes month first.
function toDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);              // 2026-09-14
  if (m) {
    return m[1] + '-' + String(+m[2]).padStart(2, '0') +
           '-' + String(+m[3]).padStart(2, '0');
  }

  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);      // 09/14/2026
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return y + '-' + String(+m[1]).padStart(2, '0') +
           '-' + String(+m[2]).padStart(2, '0');
  }

  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/); // Sep 14, 2026
  if (m && MONTHS[m[1].toLowerCase()]) {
    return m[3] + '-' + String(MONTHS[m[1].toLowerCase()]).padStart(2, '0') +
           '-' + String(+m[2]).padStart(2, '0');
  }

  return null;
}

module.exports = { splitLine, splitTabLine, toAmount, toDate, MONTHS };

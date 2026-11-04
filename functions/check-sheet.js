// Netlify Function: check-sheet
// The printable page itself, as HTML a browser can print.
//
//   GET ?t=<token from check-print>
//
// ---------------------------------------------------------------------
// Why a page and not a PDF
//
// The phone cannot print. iOS prints through Safari's share sheet, so
// the phone opens this URL and the person taps Share, Print. That works
// on every iPhone with no library added to the app -- which matters,
// because adding one would mean a new binary through TestFlight before
// Raz could print anything at all.
//
// The desktop can use it too: it is the same geometry the Pay screen
// draws, so a check printed from the phone lands in exactly the same
// place as one printed from the computer.
//
// The token is checked here rather than a session, because a browser
// opened from the app carries no Authorization header. lib/sheettoken.js
// says what that token is and why it is safe.

const { createClient } = require('@supabase/supabase-js');
const { safely } = require('./lib/guard');
const { open } = require('./lib/sheettoken');
const { amountInWords, amountInFigures, fill } = require('./lib/checkwords');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const page = (status, html) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    // Never cached, never indexed. It is a one-off link to a page of
    // somebody's checks.
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  },
  body: html,
});

const sorry = (title, line) => page(200,
  '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>' + esc(title) + '</title></head>'
  + '<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'
  + '\'Segoe UI\',Roboto,sans-serif;background:#f4f6f9;color:#121826">'
  + '<div style="max-width:460px;margin:0 auto;padding:64px 22px">'
  + '<h1 style="font-size:21px;margin:0 0 10px">' + esc(title) + '</h1>'
  + '<p style="font-size:15px;line-height:1.6;color:#5d6779;margin:0">'
  + esc(line) + '</p></div></body></html>');

// The same geometry as the Pay screen, in inches from the top-left of
// the sheet. Kept here as well because this page must be able to stand
// alone in a browser that has never seen the app.
// A check written in California is dated the American way. Printing
// 2026-11-03 where QuickBooks prints 11/03/2026 is not a style choice --
// it is a date a teller has to stop and think about.
function checkDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return m[2] + '/' + m[3] + '/' + m[1];
}

const AT = {
  date: [6.45, 0.95],
  payee: [0.95, 1.42],
  figures: [6.75, 1.40],
  words: [0.52, 1.80],
  address: [0.95, 2.08],
  memo: [0.62, 2.92],
  stub1: [0.60, 4.30],
  stub2: [0.60, 7.90],
};

exports.handler = safely('check-sheet', async (event) => {
  const q = event.queryStringParameters || {};
  const claim = open(q.t);
  if (!claim) {
    return sorry('This print link has expired',
      'Print links last ten minutes. Go back to Razi-Nova and press print again '
      + '— the checks are already numbered, so nothing is lost.');
  }

  // ---- where the printing lands on HIS paper ---------------------------
  //
  // The positions below are for a standard business check. Every bank's
  // stock sits slightly differently, and his Bank of the Sierra pad does
  // not match the default. Until now the only way to move the printing
  // was to pass dx/dy on the URL by hand, and whatever he worked out was
  // forgotten the moment he closed the page.
  //
  // So the account carries the offsets, and they are applied here. The
  // nudge on the URL still works and is added on top, which is what
  // makes the alignment sheet usable: try a value, look at the paper,
  // keep it.
  const acctRes = await supabase
    .from('bank_accounts')
    .select('check_offset_x, check_offset_y')
    .eq('store_id', claim.store_id)
    .limit(1)
    .maybeSingle();

  const savedX = acctRes.data ? Number(acctRes.data.check_offset_x) || 0 : 0;
  const savedY = acctRes.data ? Number(acctRes.data.check_offset_y) || 0 : 0;

  const dx = savedX + (Number(q.dx || 0) || 0);
  const dy = savedY + (Number(q.dy || 0) || 0);

  const res = await supabase
    .from('payments')
    .select('payment_id, vendor_id, amount, payment_date, memo, check_number, status')
    .eq('store_id', claim.store_id)
    .in('payment_id', claim.payment_ids);
  if (res.error) return sorry('Could not load these checks', res.error.message);

  const rows = res.data || [];
  if (!rows.length) return sorry('Nothing to print', 'These checks are no longer on file.');

  const vres = await supabase
    .from('vendors')
    .select('vendor_id, name, address_line1, address_line2, city, state, postal_code')
    .eq('store_id', claim.store_id);
  const vById = {};
  (vres.data || []).forEach((v) => { vById[v.vendor_id] = v; });

  // In the order the numbers were handed out, so the paper matches the
  // stack coming out of the printer.
  const ordered = claim.payment_ids
    .map((id) => rows.filter((r) => r.payment_id === id)[0])
    .filter(Boolean)
    .sort((a, b) => Number(a.check_number || 0) - Number(b.check_number || 0));

  const at = (spot, extra) =>
    'left:' + (spot[0] + dx) + 'in;top:' + (spot[1] + dy + (extra || 0)) + 'in';

  // ---- the alignment sheet --------------------------------------------
  //
  // Printed on one real check. Every field prints where the system
  // thinks it goes, with a ruler in inches running out from it. He looks
  // at the paper, reads off how far the writing is from where it should
  // be, and types those two numbers in once. They are saved to the
  // account and every check after that lands right.
  //
  // This exists because the alternative is him describing a photograph
  // to somebody who then guesses at sixteenths of an inch.
  if (q.cal === '1') {
    let cal = '<div class="sheet">';
    const ticks = (x, y, horizontal) => {
      let out = '';
      for (let i = -8; i <= 8; i++) {
        const v = i * 0.125;
        const lx = horizontal ? x + v : x;
        const ly = horizontal ? y : y + v;
        if (lx < 0 || ly < 0 || lx > 8.2 || ly > 10.7) continue;
        const major = i % 8 === 0;
        const mid = i % 4 === 0;
        out += '<div style="position:absolute;left:' + lx + 'in;top:' + ly + 'in;'
          + 'width:' + (horizontal ? '0.6pt' : (major ? '0.26in' : mid ? '0.17in' : '0.09in'))
          + ';height:' + (horizontal ? (major ? '0.26in' : mid ? '0.17in' : '0.09in') : '0.6pt')
          + ';background:#000"></div>';
        if (major && i !== 0) {
          out += '<div class="f" style="left:' + (lx + (horizontal ? 0.02 : 0.28))
            + 'in;top:' + (ly + (horizontal ? 0.26 : -0.06)) + 'in;font-size:7pt">'
            + (i > 0 ? '+' : '') + v.toFixed(1) + '"</div>';
        }
      }
      return out;
    };

    Object.keys(AT).forEach((name) => {
      const spot = AT[name];
      const x = spot[0] + dx;
      const y = spot[1] + dy;
      cal += '<div class="f" style="left:' + x + 'in;top:' + y + 'in;'
        + 'font-size:8pt;font-weight:700">\u2190 ' + name + '</div>';
      cal += ticks(x, y, true) + ticks(x, y, false);
    });

    cal += '<div class="f" style="left:0.5in;top:9.9in;font-size:9pt;max-width:7.4in;'
      + 'white-space:normal;line-height:1.4">'
      + 'Alignment sheet. Each label sits where Razi-Nova will print that field. '
      + 'Find <b>payee</b> and measure, in inches, how far it is from where the '
      + 'payee line actually starts on the check. Right is +, left is \u2212 for '
      + 'across; down is +, up is \u2212 for the other. '
      + 'Current offset: across ' + dx.toFixed(3) + '&quot;, down ' + dy.toFixed(3)
      + '&quot;. Put the two numbers into Razi-Nova and print this again to check.'
      + '</div>';
    cal += '</div>';

    const calHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="robots" content="noindex, nofollow">'
      + '<title>Check alignment</title><style>'
      + 'html,body{margin:0;padding:0;background:#e9edf3}'
      + '.sheet{position:relative;width:8.5in;height:11in;background:#fff;'
      + 'margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",'
      + 'Roboto,Helvetica,Arial,sans-serif}'
      + '.f{position:absolute;white-space:pre;font-size:11pt}'
    + '.stubamt{left:auto !important;right:0.75in;text-align:right}'
      + '@media print{html,body{background:#fff}.sheet{margin:0}'
      + '@page{size:letter;margin:0}}'
      + '</style></head><body>' + cal + '</body></html>';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      },
      body: calHtml,
    };
  }

  let sheets = '';
  ordered.forEach((p) => {
    const v = vById[p.vendor_id] || {};
    const amount = money(p.amount);
    const words = amountInWords(amount);
    if (words === null) return;

    const address = [v.address_line1, v.address_line2,
      [v.city, v.state].filter(Boolean).join(', '), v.postal_code].filter(Boolean);

    // The stub.
    //
    // It used to be one cramped line that began with the check number --
    // and that number is already printed on the paper by the bank. When
    // the two disagreed, as they did on 9960, the stub was the thing
    // asserting the wrong one. So the number is not printed here at all:
    // it cannot contradict the paper if it is not on it.
    //
    // Laid out like QuickBooks' because his are the two sitting side by
    // side on the desk, and the one he has filed for years is the one he
    // can read without looking twice.
    const stubName = esc(v.name || '');
    const stubWhen = esc(checkDate(p.payment_date));
    const stubMemo = p.memo ? esc(p.memo) : '';

    sheets += '<div class="sheet">'
      + '<div class="f big" style="' + at(AT.date) + '">' + esc(checkDate(p.payment_date)) + '</div>'
      + '<div class="f big" style="' + at(AT.payee) + '">' + esc(v.name || '') + '</div>'
      + '<div class="f big" style="' + at(AT.figures) + '">' + esc(amountInFigures(amount)) + '</div>'
      + '<div class="f words" style="' + at(AT.words) + '">' + esc(fill(words, 95)) + '</div>';

    address.forEach((line, i) => {
      sheets += '<div class="f" style="' + at(AT.address, i * 0.18) + '">' + esc(line) + '</div>';
    });

    if (p.memo) {
      sheets += '<div class="f" style="' + at(AT.memo) + '">' + esc(p.memo) + '</div>';
    }
    const stubBlock = (spot) =>
      '<div class="f stub" style="' + at(spot) + '">RAZCO LINDSAY INC   '
        + 'RAZCO FOODS SUPERMARKET</div>'
      + '<div class="f stub" style="' + at(spot, 0.40) + '">' + stubWhen
        + '      <b>' + stubName + '</b></div>'
      // The leading asterisks guard the figure on the check face, where
      // somebody could otherwise write a digit in front of it. On a stub
      // there is nothing to guard, and QuickBooks prints it plain.
      + '<div class="f stub stubamt" style="' + at(spot, 0.0) + '">'
        + esc(String(amountInFigures(amount)).replace(/^\*+/, '')) + '</div>'
      + (stubMemo
        ? '<div class="f stub" style="' + at(spot, 0.74) + '">' + stubMemo + '</div>'
        : '');

    sheets += stubBlock(AT.stub1) + stubBlock(AT.stub2) + '</div>';
  });

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const range = ordered.length > 1
    ? first.check_number + ' to ' + last.check_number
    : String(first.check_number);

  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow">'
    + '<title>Checks ' + esc(range) + '</title><style>'
    + 'html,body{margin:0;padding:0;background:#e9edf3}'
    + '.hint{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
    + 'max-width:8.5in;margin:0 auto;padding:18px 20px;color:#121826}'
    + '.hint h1{font-size:17px;margin:0 0 6px}'
    + '.hint p{font-size:14px;line-height:1.55;color:#5d6779;margin:0 0 10px}'
    + '.hint button{font:inherit;font-size:15px;font-weight:800;color:#fff;'
    + 'background:#d4262c;border:0;border-radius:11px;padding:14px 20px;width:100%;'
    + 'cursor:pointer}'
    + '.sheet{position:relative;width:8.5in;height:11in;background:#fff;'
    + 'margin:0 auto 14px;font-family:"Courier New",Courier,monospace;color:#000;'
    + 'overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.18)}'
    + '.f{position:absolute;white-space:pre;font-size:11pt}'
    + '.f.big{font-size:12pt}.f.words{font-size:11.5pt}'
    + '.f.stub{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:9pt}'
    + '@media print{'
    + '.hint{display:none !important}'
    + 'html,body{background:#fff}'
    + '.sheet{margin:0;box-shadow:none;page-break-after:always}'
    + '.sheet:last-child{page-break-after:auto}'
    + '@page{size:letter portrait;margin:0}'
    + '}</style></head><body>'
    + '<div class="hint">'
    + '<h1>' + ordered.length + ' check' + (ordered.length === 1 ? '' : 's')
    + ' &middot; ' + esc(range) + '</h1>'
    + '<p>Load the check stock, then print. On a phone: Share, then Print. '
    + 'Turn off any &ldquo;fit to page&rdquo; or scaling &mdash; it must print at '
    + '100% or nothing lands where it should.</p>'
    + '<button type="button" onclick="window.print()">Print</button>'
    + '</div>'
    + sheets
    + '</body></html>';

  return page(200, html);
});

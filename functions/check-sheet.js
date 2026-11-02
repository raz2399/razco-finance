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

  const dx = Number(q.dx || 0) || 0;
  const dy = Number(q.dy || 0) || 0;

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

  let sheets = '';
  ordered.forEach((p) => {
    const v = vById[p.vendor_id] || {};
    const amount = money(p.amount);
    const words = amountInWords(amount);
    if (words === null) return;

    const address = [v.address_line1, v.address_line2,
      [v.city, v.state].filter(Boolean).join(', '), v.postal_code].filter(Boolean);

    const stub = esc(p.payment_date) + '   #' + esc(p.check_number) + '   '
      + esc(v.name || '') + '   $' + amount.toFixed(2)
      + (p.memo ? '   ' + esc(p.memo) : '');

    sheets += '<div class="sheet">'
      + '<div class="f big" style="' + at(AT.date) + '">' + esc(p.payment_date) + '</div>'
      + '<div class="f big" style="' + at(AT.payee) + '">' + esc(v.name || '') + '</div>'
      + '<div class="f big" style="' + at(AT.figures) + '">' + esc(amountInFigures(amount)) + '</div>'
      + '<div class="f words" style="' + at(AT.words) + '">' + esc(fill(words, 95)) + '</div>';

    address.forEach((line, i) => {
      sheets += '<div class="f" style="' + at(AT.address, i * 0.18) + '">' + esc(line) + '</div>';
    });

    if (p.memo) {
      sheets += '<div class="f" style="' + at(AT.memo) + '">' + esc(p.memo) + '</div>';
    }
    sheets += '<div class="f stub" style="' + at(AT.stub1) + '">' + stub + '</div>'
      + '<div class="f stub" style="' + at(AT.stub2) + '">' + stub + '</div>'
      + '</div>';
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

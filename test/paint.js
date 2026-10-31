// Loads index.html in a real DOM, stubs the network with the exact payload
// overview.js produces, signs in, and checks what the screen actually shows.

const fs = require('fs');
const path = require('path');
require('./stub-guard');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// ---- build the payload from the real function, same mock as overtest ----
function buildPayload() {
  // Regenerated from the fixture every run. A checked-in snapshot silently
  // goes stale the moment overtest.js changes, and the tests then pass
  // against numbers the code no longer produces.
  const child = require('child_process');
  const src = fs.readFileSync(path.join(__dirname, 'overtest.js'), 'utf8');
  const head = src.split('const { handler } = require')[0];
  fs.writeFileSync(path.join(__dirname, 'payload.js'), head +
    "const { handler } = require(require('path').join(__dirname, '..', 'functions', 'overview.js'));\n" +
    "(async () => {\n" +
    "  const res = await handler({ httpMethod: 'GET',\n" +
    "    queryStringParameters: { store_id: 'store1', week_start: '2026-09-07' } });\n" +
    "  process.stdout.write(res.body);\n" +
    "})();\n");
  return Promise.resolve(JSON.parse(
    child.execSync('node ' + path.join(__dirname, 'payload.js'), { encoding: 'utf8' })));
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  if (String(actual) === String(expected)) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got      ' + actual + '\n       expected ' + expected); }
}
function checkTrue(name, cond, note) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (note ? ' (' + note + ')' : '')); }
}

(async () => {
  const payload = await buildPayload();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    // without a real origin jsdom refuses localStorage, which the app uses
    // to remember the session
    url: 'https://famous-caramel-1cf571.netlify.app/',
  });
  const win = dom.window;

  // Stub the network: every GET answers with the overview payload.
  const calls = [];
  win.XMLHttpRequest = function () {
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this.open = function (method, url) { calls.push(url); this._url = url; };
    this.setRequestHeader = function () {};
    this.send = function () {
      const self = this;
      self.readyState = 4;
      if (self._url.indexOf('/overview') > -1) {
        self.status = 200;
        self.responseText = JSON.stringify(payload);
      } else if (self._url.indexOf('/weekly-close') > -1) {
        self.status = 200;
        self.responseText = JSON.stringify({
          week_start: '2026-09-07', week_end: '2026-09-13', today: '2026-09-14',
          week_is_over: true, closed: false, frozen: null,
          live: { income: 35440, expense: 8760, net: 26680, cash: 10752, card: 24568, check: 120,
                  in_bank: 18000, outstanding_checks: 3160, open_ap: 9400, days_with_sales: 3 },
          warnings: ['Only 3 of 7 days have register sales.'],
        });
      } else {
        self.status = 200;
        self.responseText = '{}';
      }
      if (self.onreadystatechange) self.onreadystatechange();
    };
  };

  await new Promise((r) => win.addEventListener('load', r));

  const APP = win.APP;
  checkTrue('APP is on the page', !!APP);

  // Paint the dashboard directly with the payload.
  APP.paintHome(payload);
  const $ = (id) => win.document.getElementById(id);
  const txt = (id) => ($(id) ? $(id).textContent.trim() : '<<missing ' + id + '>>');

  console.log('\nKPI row');
  check('left after everything clears', txt('k-left'), '$4,947');
  check('in the bank', txt('k-bank'), '$18,000');
  check('checks not cleared', txt('k-out'), '$3,653');
  check('owed to vendors', txt('k-ap'), '$9,400');
  checkTrue('bank note names the account', txt('k-bank-n').indexOf('5269') > -1, txt('k-bank-n'));
  checkTrue('check note counts them', txt('k-out-n').indexOf('3 checks') > -1, txt('k-out-n'));

  console.log('\nWeek table');
  const rows = win.document.querySelectorAll('#rn-weekbody tr');
  check('seven days plus a total row', rows.length, 8);
  const mon = rows[0].querySelectorAll('td');
  check('Monday label', mon[0].textContent.trim(), 'Mon 7');
  check('Monday cash', mon[1].textContent.trim(), '$9,752');
  check('Monday card', mon[2].textContent.trim(), '$24,568');
  checkTrue('check column hidden when nobody paid by check',
    $('th-check').style.display === 'none' || payload.week.some((w) => w.check > 0));
  const tot = rows[7].querySelectorAll('td');
  check('total row label', tot[0].textContent.trim(), 'Total');
  checkTrue('total row is marked', rows[7].className.indexOf('tot') > -1);

  console.log('\nFormula strip');
  const f = txt('rn-formula');
  checkTrue('shows income', f.indexOf('$35,440') > -1, f);
  checkTrue('shows expense', f.indexOf('$9,253') > -1, f);
  checkTrue('shows the result', f.indexOf('$26,188') > -1, f);
  checkTrue('says left on hand', f.indexOf('left on hand') > -1);

  console.log('\nNeeds you');
  const needs = win.document.querySelectorAll('#rn-needs .rn-need');
  checkTrue('alerts are listed', needs.length === payload.alerts.length, needs.length + ' vs ' + payload.alerts.length);
  checkTrue('the first one is critical', needs.length === 0 || needs[0].className.indexOf('critical') > -1);
  checkTrue('mobile shows the same list',
    win.document.querySelectorAll('#rn-needs-m .rn-need').length === needs.length);

  console.log('\nChecks still out');
  const chk = win.document.querySelectorAll('#rn-checks .rn-row');
  check('three checks listed', chk.length, 3);
  checkTrue('check number is shown',
    /#(510\d|9897)/.test(chk[0].textContent), chk[0].textContent);
  // Written today should read "today", not "1 days ago".
  //
  // The boundary matters: a plain indexOf('1 days ago') also matches the
  // "1 days ago" inside "11 days ago", so this failed every time a check
  // happened to be 11, 21 or 31 days old -- a test that cried wolf on the
  // calendar rather than on the code.
  checkTrue('no check reads "1 days ago"',
    Array.prototype.every.call(chk, function (r) {
      return !/(^|\D)1 days ago/.test(r.textContent);
    }), Array.prototype.map.call(chk, function (r) { return r.textContent; }).join(' | '));

  checkTrue('and a check one day old reads "1 day ago"',
    !/\b1 days ago\b/.test(win.document.getElementById('rn-checks').innerHTML));

  console.log('\nOwed by vendor');
  const ven = win.document.querySelectorAll('#rn-vendors .rn-row');
  check('two vendors owed', ven.length, 2);
  checkTrue('vendor named', ven[0].textContent.indexOf('C&S') > -1, ven[0].textContent);
  checkTrue('overdue amount is marked red',
    ven[0].querySelector('.amt').className.indexOf('due') > -1);

  console.log('\nMobile screen');
  check('hero number matches the KPI', txt('m-left'), '$4,947');
  check('income', txt('m-in'), '$35,440');
  check('expense', txt('m-out'), '$9,253');

  console.log('\nStale data banner');
  checkTrue('banner is shown when sales are behind', $('rn-stale').style.display === 'block');
  checkTrue('banner says how far behind', txt('rn-stale').indexOf('days behind') > -1, txt('rn-stale'));

  console.log('\nTrend');
  checkTrue('bars drawn', win.document.querySelectorAll('#rn-spark .rn-bar').length > 0);

  console.log('\nNegative cash turns red');
  const bad = JSON.parse(JSON.stringify(payload));
  bad.position.after_everything = -2500;
  APP.paintHome(bad);
  check('negative formatting', txt('k-left'), '-$2,500');
  checkTrue('negative gets the red class', $('k-left').className.indexOf('neg') > -1);
  checkTrue('mobile hero also red', $('m-left').className.indexOf('neg') > -1);

  console.log('\nEmpty week does not crash');
  const empty = {
    today: '2026-10-21', week_start: '2026-10-19', week_end: '2026-10-25',
    week: payload.week.map((w) => ({ date: w.date, cash: 0, card: 0, check: 0, income: 0, expense: 0, net: 0, has_data: false })),
    week_totals: { cash: 0, card: 0, check: 0, income: 0, expense: 0, left_on_hand: 0 },
    position: { in_bank: 0, checks_outstanding: 0, after_checks_clear: 0, ap_open: 0, after_everything: 0, checks_outstanding_count: 0, ap_open_count: 0 },
    checks: [], vendors: [], alerts: [], ledger: [], trend: [], freshness: {},
  };
  let threw = null;
  try { APP.paintHome(empty); } catch (e) { threw = e; }
  checkTrue('no crash on an empty week', !threw, threw && threw.message);
  checkTrue('says nothing needs you', txt('rn-needs').indexOf('Nothing needs you') > -1);
  checkTrue('says every check cleared', txt('rn-checks').indexOf('cleared') > -1);
  checkTrue('banner hidden when data is current', $('rn-stale').style.display === 'none');

  console.log('\nWeek navigation');
  calls.length = 0;
  APP.shiftWeek(-7);
  const overviewCalls = calls.filter((u) => u.indexOf('/overview') > -1);
  checkTrue('going back asks for the previous Monday',
    overviewCalls.length === 1 && overviewCalls[0].indexOf('week_start=') > -1, calls.join(' | '));
  const wk = overviewCalls[0].split('week_start=')[1].split('&')[0];
  checkTrue('that Monday is 7 days earlier', /^\d{4}-\d{2}-\d{2}$/.test(wk), wk);
  calls.length = 0;
  APP.week_start = null;
  APP.loadHome();
  const fresh = calls.filter((u) => u.indexOf('/overview') > -1);
  checkTrue('"this week" sends no week_start', fresh[0].indexOf('week_start') === -1, fresh[0]);

  console.log('\nSunday close');
  APP.paintHome(payload);
  APP.loadClose();
  check('the card says the week is ready', txt('rn-close-state'), 'READY');
  checkTrue('the warning is shown', txt('rn-close-body').indexOf('3 of 7 days') > -1, txt('rn-close-body'));
  checkTrue('income and expense are stated',
    txt('rn-close-body').indexOf('$35,440') > -1 && txt('rn-close-body').indexOf('$8,760') > -1);

  const cashIn = $('rn-cash-on-hand');
  checkTrue('there is somewhere to type the cash count', !!cashIn);
  cashIn.value = '4,000';
  cashIn.dispatchEvent(new win.Event('input'));
  const prevTxt = txt('rn-close-preview');
  checkTrue('a comma in the number does not break it', prevTxt.indexOf('$4,000.00') > -1, prevTxt);
  checkTrue('the week total is 4000 + 35440 - 8760', prevTxt.indexOf('$30,680.00') > -1, prevTxt);

  cashIn.value = '$2500.50';
  cashIn.dispatchEvent(new win.Event('input'));
  checkTrue('a dollar sign is fine too', txt('rn-close-preview').indexOf('$29,180.50') > -1,
    txt('rn-close-preview'));

  cashIn.value = 'abc';
  cashIn.dispatchEvent(new win.Event('input'));
  checkTrue('nonsense shows no total, rather than a wrong one',
    txt('rn-close-preview').indexOf('Enter the cash') > -1, txt('rn-close-preview'));

  console.log('\nA locked week');
  APP.paintClose({
    week_start: '2026-09-07', week_end: '2026-09-13', closed: true,
    closed_at: '2026-09-14T06:10:00Z',
    frozen: { cash_position: 30680, operating_exp: 8760, net_sales: 35440,
              operating_profit: 26680, outstanding_checks: 3160, open_ap: 9400 },
    live: { income: 1, expense: 1, net: 0 }, warnings: [],
  });
  check('it says locked', txt('rn-close-state'), 'LOCKED');
  checkTrue('and shows the number that was written down',
    txt('rn-close-body').indexOf('$30,680.00') > -1, txt('rn-close-body'));
  checkTrue('there is no way to type a new cash count', !$('rn-cash-on-hand'));
  checkTrue('reopening is offered', !!$('rn-reopen'));

  console.log('\nVendor suggestions');
  // The name box used to be filled from invoices only, so 31 vendors could
  // sit in the database and the box would suggest nothing at all.
  APP.invoice_data = {
    vendor_list: [
      { vendor_name: 'SALTERS DISTRIBUTING', pay_method: 'unknown', terms: '' },
      { vendor_name: 'Sysco', pay_method: 'charge_account', terms: 'net15' },
    ],
    invoices: [{ vendor_name: 'Dona G Sales', pay_method: 'auto_debit', terms: 'net30' }],
  };
  APP.paintVendors([]);
  const sug = win.document.getElementById('inv-vendor-list').innerHTML;
  checkTrue('a vendor with no invoice is still suggested',
    sug.indexOf('SALTERS DISTRIBUTING') > -1, sug);
  checkTrue('so is one that only appears on an invoice', sug.indexOf('Dona G Sales') > -1, sug);
  check('and nobody is listed twice', (sug.match(/<option/g) || []).length, 3);

  console.log('\nA vendor whose payment type was never recorded');
  $('inv-vendor').value = 'SALTERS DISTRIBUTING';
  APP.onVendorTyped();
  checkTrue('is recognised as on file', $('inv-vendor-known').style.display !== 'none');
  checkTrue('is not labelled a charge account',
    txt('inv-vendor-known').toLowerCase().indexOf('charge account') === -1,
    txt('inv-vendor-known'));
  checkTrue('says the payment type is not set', txt('inv-vendor-known').indexOf('not set') > -1);
  checkTrue('and asks him to pick one', $('inv-setup').style.display === 'block');
  checkTrue('nothing is carried forward as a method', !APP.pending_method);

  console.log('\nEvery button that changes screen lands somewhere');
  // "Record a delivery" and "Write checks that are due" called screens by
  // names from the nine-tab layout. The restructure renamed them, these
  // were missed, and the call hid every panel and then threw -- a blank
  // white page.
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const asked = (src.match(/switchTab\('([a-z-]+)'\)/g) || [])
    .map((m) => m.replace(/switchTab\('|'\)/g, ''));
  checkTrue('some buttons do switch screens', asked.length > 0);
  asked.forEach((n) => {
    checkTrue('"' + n + '" is a screen that exists', !!$(n + '-tab'), n);
  });

  console.log('\nAnd a name that is not a screen leaves him where he was');
  APP.switchTab('money');
  const before = $('money-tab').className;
  let badTabThrew = null;
  try { APP.switchTab('charges'); } catch (e) { badTabThrew = e; }
  checkTrue('it does not throw', !badTabThrew, badTabThrew && badTabThrew.message);
  check('the screen he was on is still showing', $('money-tab').className, before);
  checkTrue('rather than a blank page',
    win.document.querySelectorAll('.tab-content.active').length === 1);

  console.log('\nAdding and removing');
  let venThrew = null;
  try { APP.switchTab('vendors'); } catch (e) { venThrew = e; }
  checkTrue('the Vendors screen still opens', !venThrew, venThrew && venThrew.message);
  checkTrue('a way to add a vendor', !!$('vl-new') && !!$('vl-new-box'));
  checkTrue('with a name field', !!$('vl-new-name'));
  checkTrue('a way to remove the open vendor', !!$('vl-remove'));
  checkTrue('and the add-a-line form can ask for a category', !!$('vl-f-catwrap') && !!$('vl-f-cat'));

  // The category question must be hideable -- a vendor that already has
  // one should never be asked again, which is the whole point.
  checkTrue('the category box starts hidden',
    /id="vl-f-catwrap" style="display:none"/.test(src));
  checkTrue('and is only shown when the vendor has none',
    /if \(self\.vl_vendor_category\)[\s\S]{0,80}display = 'none'/.test(src));

  // Remove must go through the server's decision, never decide locally
  // whether something is deleted or voided.
  checkTrue('every line offers Remove',
    /data-act="remove"/.test(src));
  checkTrue('and Remove asks the server, which picks delete or void',
    /action: 'delete', kind: kind, id: id/.test(src));

  console.log('\nPrinting checks');
  let payThrew = null;
  try { APP.switchTab('pay'); } catch (e) { payThrew = e; }
  checkTrue('the Pay screen still opens', !payThrew, payThrew && payThrew.message);
  checkTrue('there is somewhere to print from', !!$('print-card'));
  checkTrue('a place to say which check is in the printer', !!$('print-start'));
  checkTrue('and to nudge the alignment', !!$('print-dx') && !!$('print-dy'));
  checkTrue('a sheet layer to print into', !!$('check-sheets'));

  // The printable layer must be hidden on screen and the only thing
  // visible on paper. Getting this backwards prints the whole app.
  checkTrue('the sheets are hidden on screen',
    /#check-sheets\s*\{\s*display:\s*none/.test(src));
  checkTrue('and everything else is hidden on paper',
    /@media print[\s\S]{0,200}body > \*:not\(#check-sheets\)/.test(src));
  checkTrue('the page is letter size with no margin',
    /@page\s*\{\s*size:\s*letter portrait;\s*margin:\s*0/.test(src));

  // Positions are in inches, and the nudge is added to every one of
  // them -- a layout where the offset only reached some fields would be
  // worse than none.
  checkTrue('every field is placed through the nudge helper',
    (src.match(/this\.at\(L\./g) || []).length >= 6);
  checkTrue('the nudge is added to both axes',
    /left:'\s*\+\s*\(spot\.x \+ n\.x\)/.test(src)
    && /top:'\s*\+\s*\(spot\.y \+ n\.y/.test(src));

  console.log('\nThe Reconcile screen');
  // The work that makes every other screen truer: matching the bank,
  // and the two facts about a vendor nothing can infer. Each tested for
  // the thing that would make it useless -- a tab with no panel, a
  // button with nothing behind it, a list with nowhere to draw into.
  checkTrue('there is a tab for it', !!win.document.querySelector('[data-tab="reconcile"]'));
  checkTrue('and a panel behind the tab', !!$('reconcile-tab'));
  let recThrew = null;
  try { APP.switchTab('reconcile'); } catch (e) { recThrew = e; }
  checkTrue('opening it does not throw', !recThrew, recThrew && recThrew.message);
  checkTrue('it is the screen now showing',
    $('reconcile-tab').className.indexOf('active') > -1);
  checkTrue('somewhere to start the match', !!$('rec-preview'));
  checkTrue('somewhere to put the tally', !!$('rec-tally'));
  checkTrue('somewhere to say what went wrong', !!$('rec-msg'));
  checkTrue('a place for disagreements', !!$('rec-problems'));
  checkTrue('a place to name unknown lines', !!$('rec-unknowns'));
  checkTrue('a place for vendors with no category', !!$('rec-cats'));
  checkTrue('a place for vendors with no terms', !!$('rec-terms'));
  checkTrue('a place for the 1099s', !!$('rec-1099'));
  checkTrue('and somewhere for things already waiting on him', !!$('rec-attn'));

  // The preview button must not write. This is the one that touches 2,660
  // rows of real books, so the default has to be "show me".
  checkTrue('preview asks for a preview, not an apply',
    /action:\s*apply\s*\?\s*'apply'\s*:\s*'preview'/.test(src)
    || /apply\s*\?\s*'apply'\s*:\s*'preview'/.test(src));
  checkTrue('and the screen opens without having applied anything',
    !!$('rec-tally') && $('rec-tally').innerHTML.indexOf('Apply this') === -1);

  console.log('\nThe bank connection card');
  const bankSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  checkTrue('the card is on the Money screen', !!$('bank-link-card'));
  checkTrue('with somewhere to say what is connected', !!$('bank-link-state'));

  // The page must never be handed anything that can read the account. It
  // asks the server for a link token, which opens Plaid's window and can do
  // nothing else; the client id and the secret stay in Netlify.
  checkTrue('the page asks for a link token', bankSrc.indexOf("action: 'token'") > -1);
  // The names may appear in a message telling Raz what to put in Netlify.
  // What must never appear is a value, or a request that carries one.
  checkTrue('it never sends a client id or secret to Plaid',
    !/client_id\s*:/.test(bankSrc) && !/\bsecret\s*:/.test(bankSrc));
  // The page does hold a session token from signing in -- that is what a
  // session is. What it must never hold is Plaid's access token, which can
  // read the bank account itself. The page's bank code deals only in a link
  // token and a public token, both of which are short-lived and harmless.
  const bankCode = bankSrc.slice(
    bankSrc.indexOf('connectBank: function'),
    bankSrc.indexOf('bankMsg: function'));
  checkTrue('the bank code never touches a Plaid access token',
    bankCode.indexOf('access_token') === -1);
  checkTrue('it deals in a link token and a public token only',
    bankCode.indexOf('link_token') > -1 && bankCode.indexOf('public_token') > -1);
  // A Plaid client id is 24 hex characters and a secret is 30. Anything of
  // that shape sitting in the page is a credential that has leaked into it.
  const creds = bankSrc.match(/['"][0-9a-f]{24,32}['"]/g) || [];
  checkTrue('and no credential-shaped literal is in the page',
    creds.length === 0, creds.join(' '));

  console.log('\nWhat it shows after a read');
  APP.bankMsg('ok', 'test message');
  checkTrue('messages are shown', $('bank-link-msg').style.display === 'block');
  checkTrue('and say what they say', txt('bank-link-msg').indexOf('test message') > -1);
  // Posted and available are different numbers and the screen must name
  // which is which: on this account they were $95,420 apart in a morning.
  checkTrue('the read names both balances',
    bankSrc.indexOf('Posted balance') > -1 && bankSrc.indexOf('available') > -1);
  checkTrue('and explains what available means',
    bankSrc.indexOf('what the bank will let you spend') > -1);

  console.log('\nSigning in');
  const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  // The old login ignored the password entirely, invented a token from the
  // clock, and let whoever was typing choose their own role from a
  // dropdown. Any one of those three is the whole door.
  checkTrue('the password is actually sent',
    /action: 'login'[\s\S]{0,200}password: password/.test(pageSrc));
  checkTrue('no token is invented in the page',
    !/token_['"]?\s*\+\s*Date\.now/.test(pageSrc));
  checkTrue('and the role is not chosen by whoever is signing in',
    pageSrc.indexOf('<option value="owner">') === -1);
  checkTrue('the role comes back from the server',
    /d\.user\.role|user_role = d\.user/.test(pageSrc));

  console.log('\nThe session');
  checkTrue('a stored token is checked with the server, not trusted',
    /restoreSession[\s\S]{0,900}this\.get\('\/auth'/.test(pageSrc));
  checkTrue('the password is never stored',
    !/setItem\(['"]rn_password|localStorage[\s\S]{0,40}password/.test(pageSrc));
  checkTrue('signing out tells the server too',
    /logout[\s\S]{0,300}action: 'logout'/.test(pageSrc));

  console.log('\nEvery request carries the token');
  const opens = (pageSrc.match(/x\.open\(/g) || []).length;
  const auths = (pageSrc.match(/this\.addAuth\(x\)/g) || []).length;
  check('one addAuth per request', auths, opens);
  checkTrue('and 401 ends the session rather than painting an error',
    /signedOut[\s\S]{0,400}showLogin/.test(pageSrc));

  console.log('\nThe vendor ledger screen');
  checkTrue('there is a Vendors screen', !!$('vendors-tab'));
  checkTrue('reachable from the tab bar',
    !!win.document.querySelector('[data-tab="vendors"]'));
  checkTrue('with a search box', !!$('vl-search'));
  checkTrue('and somewhere for the lines', !!$('vl-body'));

  const led = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // Every column he asked to sort by.
  ['date', 'number', 'amount', 'type'].forEach(function (k) {
    checkTrue('sortable by ' + k, led.indexOf("key: '" + k + "'") > -1);
  });
  checkTrue('and by a date range', led.indexOf('vl-from') > -1 && led.indexOf('vl-to') > -1);
  checkTrue('clicking the same column turns it around',
    /vl_sort === key[\s\S]{0,120}'asc'\)\s*\?\s*'desc'/.test(led));

  // The lines are the point. A screen that adds them up and shows one
  // number is the thing he already has in QuickBooks.
  checkTrue('every line shows its own balance after',
    led.indexOf('balance_after') > -1);
  checkTrue('a payment reads as money going out',
    led.indexOf('&minus; ') > -1);
  checkTrue('and an opening balance is never called an invoice',
    led.indexOf('Opening balance') > -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

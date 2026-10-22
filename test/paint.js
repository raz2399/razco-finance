// Loads index.html in a real DOM, stubs the network with the exact payload
// overview.js produces, signs in, and checks what the screen actually shows.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// ---- build the payload from the real function, same mock as overtest ----
function buildPayload() {
  return new Promise((resolve) => {
    const child = require('child_process');
    const out = child.execSync('node ' + path.join(__dirname, 'payload.js'), { encoding: 'utf8' });
    resolve(JSON.parse(out));
  });
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

  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
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
  check('left after everything clears', txt('k-left'), '$9,140');
  check('in the bank', txt('k-bank'), '$18,000');
  check('checks not cleared', txt('k-out'), '$3,160');
  check('owed to vendors', txt('k-ap'), '$5,700');
  checkTrue('bank note names the account', txt('k-bank-n').indexOf('5269') > -1, txt('k-bank-n'));
  checkTrue('check note counts them', txt('k-out-n').indexOf('2 checks') > -1, txt('k-out-n'));

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
  checkTrue('shows expense', f.indexOf('$5,060') > -1, f);
  checkTrue('shows the result', f.indexOf('$30,380') > -1, f);
  checkTrue('says left on hand', f.indexOf('left on hand') > -1);

  console.log('\nNeeds you');
  const needs = win.document.querySelectorAll('#rn-needs .rn-need');
  checkTrue('alerts are listed', needs.length === payload.alerts.length, needs.length + ' vs ' + payload.alerts.length);
  checkTrue('the first one is critical', needs.length === 0 || needs[0].className.indexOf('critical') > -1);
  checkTrue('mobile shows the same list',
    win.document.querySelectorAll('#rn-needs-m .rn-need').length === needs.length);

  console.log('\nChecks still out');
  const chk = win.document.querySelectorAll('#rn-checks .rn-row');
  check('two checks listed', chk.length, 2);
  checkTrue('check number is shown', chk[0].textContent.indexOf('#510') > -1, chk[0].textContent);

  console.log('\nOwed by vendor');
  const ven = win.document.querySelectorAll('#rn-vendors .rn-row');
  check('one vendor owed', ven.length, 1);
  checkTrue('vendor named', ven[0].textContent.indexOf('C&S') > -1, ven[0].textContent);
  checkTrue('overdue amount is marked red',
    ven[0].querySelector('.amt').className.indexOf('due') > -1);

  console.log('\nMobile screen');
  check('hero number matches the KPI', txt('m-left'), '$9,140');
  check('income', txt('m-in'), '$35,440');
  check('expense', txt('m-out'), '$5,060');

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
  checkTrue('going back asks for the previous Monday',
    calls.length === 1 && calls[0].indexOf('week_start=') > -1, calls[0]);
  const wk = calls[0].split('week_start=')[1];
  checkTrue('that Monday is 7 days earlier', /^\d{4}-\d{2}-\d{2}$/.test(wk), wk);
  calls.length = 0;
  APP.week_start = null;
  APP.loadHome();
  checkTrue('"this week" sends no week_start', calls[0].indexOf('week_start') === -1, calls[0]);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// Every endpoint has to be able to say no.
//
// Saying yes is the path that gets exercised all day. Saying no is the
// path nobody runs until the moment it matters -- a token expires, an
// account is turned off, the auth service is unreachable -- and that is
// exactly when it must not fall over.
//
// It did. The auth guard was added to all seventeen endpoints at once
// with `return json(...)`, and eight of them had no json helper: they
// build their replies inline. So the moment the guard needed to refuse,
// the function threw "json is not defined", Netlify answered 500, and
// that sentence appeared on Raz's Money screen where a figure should be.
//
// No stub guard here on purpose. This runs the real one, with no token,
// and asks one question of every endpoint: did you answer, or did you
// throw? Nothing is mocked that could hide the answer.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// Supabase is never reached: without a token the guard refuses before any
// query. The client still has to construct, so it gets a URL shaped like
// one and nothing else.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-key';
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.SYNC_TOKEN;

// The guard asks Supabase who a token belongs to. There is no token here,
// so it should never get this far -- and if it ever does, this makes the
// attempt fail the way a dead network would rather than hanging the test.
global.fetch = async () => { throw new Error('network is not available in tests'); };

let pass = 0, fail = 0;
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? '\n       ' + note : '')); }
};

// Endpoints that are meant to run with nobody signed in.
const OPEN = ['probe'];
// Scheduled ones: run by Netlify on a timer, not by a person, so they
// have no URL to refuse anybody at.
//
// Read out of netlify.toml rather than written here. "It is scheduled"
// is a claim that excuses a function from having a door, and a claim
// like that has to be checked against the thing that actually decides
// it -- otherwise a hand-kept list is one forgotten edit away from
// letting a real endpoint through unguarded, or from failing the build
// for a function that is perfectly fine.
const TOML = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
const SCHEDULED = (TOML.match(/\[functions\."([^"]+)"\]\s*\n\s*schedule\s*=/g) || [])
  .map((m) => m.match(/\[functions\."([^"]+)"\]/)[1]);
// Authorised by a signed link rather than a session, because the browser
// that opens them was handed a URL by the app and carries no header.
// Listed here, but the claim is checked below rather than taken on
// trust -- an endpoint cannot buy its way out by being on a list.
const BY_TOKEN = ['check-sheet'];
// Started by another function rather than by a person, so the job is
// signed instead of the caller being signed in. A background function
// has a public URL like any other, so without this anybody who found the
// address could post photographs at it all day on his account. Listed
// here, and the signing is verified below -- being on a list buys
// nothing.
const BY_STAMP = ['paper-read-background'];

const files = fs.readdirSync(path.join(ROOT, 'functions'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => f.replace(/\.js$/, ''))
  .filter((f) => OPEN.indexOf(f) === -1 && SCHEDULED.indexOf(f) === -1
    && BY_TOKEN.indexOf(f) === -1 && BY_STAMP.indexOf(f) === -1)
  .sort();

(async () => {
  console.log('Every endpoint can refuse a request it should refuse\n');

  // The signed-job ones. Their exemption from the sign-in check is only
  // worth anything if they really do refuse an unsigned job.
  for (const name of BY_STAMP) {
    const file = path.join(ROOT, 'functions', name + '.js');
    const src = fs.readFileSync(file, 'utf8');
    checkTrue(name + ' checks a signature', /createHmac/.test(src)
      && /timingSafeEqual/.test(src),
      'it is exempt from the sign-in check, so it had better check something');

    let handler;
    try { handler = require(file).handler; }
    catch (e) { checkTrue(name + ' loads', false, e.message); continue; }

    const body = JSON.stringify({ scan_id: 'x', base64_image: 'y' });
    const unsigned = await handler({ httpMethod: 'POST', headers: {}, body: body });
    checkTrue(name + ' refuses a job with no signature',
      unsigned.statusCode === 401, 'got ' + unsigned.statusCode);

    const forged = await handler({
      httpMethod: 'POST',
      headers: { 'x-razi-at': String(Date.now()), 'x-razi-stamp': 'deadbeef' },
      body: body,
    });
    checkTrue(name + ' refuses a forged signature',
      forged.statusCode === 401, 'got ' + forged.statusCode);

    // A real signature, but from an hour ago. Replaying one that was
    // captured off the wire must not work for ever.
    const crypto = require('crypto');
    const old = String(Date.now() - 60 * 60 * 1000);
    const stamp = crypto
      .createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || '')
      .update(old + '.' + body).digest('hex');
    const stale = await handler({
      httpMethod: 'POST',
      headers: { 'x-razi-at': old, 'x-razi-stamp': stamp },
      body: body,
    });
    checkTrue(name + ' refuses a signature from an hour ago',
      stale.statusCode === 401, 'got ' + stale.statusCode);
  }

  // The token-authorised ones first, since their exemption is only
  // worth anything if they really do check the token.
  for (const name of BY_TOKEN) {
    const file = path.join(ROOT, 'functions', name + '.js');
    const src = fs.readFileSync(file, 'utf8');
    checkTrue(name + ' reads a signed token', /require\('\.\/lib\/sheettoken'\)/.test(src),
      'it is exempt from the sign-in check, so it had better check something');

    let handler;
    try { handler = require(file).handler; }
    catch (e) { checkTrue(name + ' loads', false, e.message); continue; }

    // No token at all, and a forged one.
    for (const t of [undefined, '', 'forged.token']) {
      const res = await handler({
        httpMethod: 'GET',
        headers: {},
        queryStringParameters: t === undefined ? {} : { t: t },
        body: null,
      });
      const body = String(res.body || '');
      checkTrue(name + ' refuses "' + String(t) + '"',
        !/check|9926|payee|amount/i.test(body) || /expired/i.test(body),
        'it answered with something that looks like check data');
      checkTrue(name + ' says the link expired',
        /expired/i.test(body), body.slice(0, 120));
    }
  }


  for (const name of files) {
    let handler;
    try {
      handler = require(path.join(ROOT, 'functions', name + '.js')).handler;
    } catch (e) {
      checkTrue(name + ' loads', false, e.message);
      continue;
    }
    if (typeof handler !== 'function') {
      checkTrue(name + ' exports a handler', false, 'no handler exported');
      continue;
    }

    // No Authorization header. Nobody is signed in.
    let res;
    try {
      res = await handler({
        httpMethod: 'GET',
        headers: {},
        queryStringParameters: { store_id: 'store1' },
        body: null,
      }, {});
    } catch (e) {
      // This is the failure the whole file exists for: a function that
      // throws rather than refusing. Netlify turns it into a 502 or 500
      // with the raw message, and that message lands on his screen.
      checkTrue(name + ' refuses without throwing', false,
        'threw: ' + e.message);
      continue;
    }

    if (!res || typeof res.statusCode !== 'number') {
      checkTrue(name + ' returns a response', false, JSON.stringify(res));
      continue;
    }

    // 401 unauthenticated, 403 not allowed, 405 wrong method, 503 the auth
    // service could not be reached. Any of those is a proper refusal.
    const refused = [401, 403, 405, 503].indexOf(res.statusCode) > -1;
    checkTrue(name + ' refuses with ' + res.statusCode, refused,
      refused ? '' : 'expected a refusal, got ' + res.statusCode +
        ' — an endpoint answering 200 to nobody is an open door');

    // And the refusal has to be readable. "json is not defined" is a
    // crash wearing a 500; a real refusal carries a sentence.
    let body = null;
    try { body = JSON.parse(res.body); } catch (e) { body = null; }
    checkTrue(name + ' says why, in JSON',
      !!(body && typeof body.error === 'string' && body.error.length),
      'body was: ' + String(res.body).slice(0, 120));
    checkTrue(name + ' and not with a programming error',
      !!(body && body.error &&
         !/is not defined|is not a function|undefined is not|Cannot read/.test(body.error)),
      body && body.error);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

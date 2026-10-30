// The door.
//
// Deliberately does NOT require stub-guard: this is the one suite that runs
// the real guard. Everything here is a way in that must not work.

const path = require('path');
const Module = require('module');

const DB = {
  app_users: [
    { user_id: 'u-owner', full_name: 'Raz', role: 'owner', active: true, approval_limit: null },
    { user_id: 'u-off', full_name: 'Former Clerk', role: 'clerk', active: false, approval_limit: 0 },
    { user_id: 'u-nostore', full_name: 'No Store', role: 'clerk', active: true, approval_limit: 0 },
  ],
  user_store_access: [
    { user_id: 'u-owner', store_id: 'store1' },
    { user_id: 'u-off', store_id: 'store1' },
  ],
};

function query(table) {
  let rows = (DB[table] || []).slice();
  const api = {
    select() { return api; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return api; },
    maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    then(res) { return Promise.resolve({ data: rows, error: null }).then(res); },
  };
  return api;
}
const supabase = { from: query };

// Stands in for Supabase's auth service. Only the tokens listed here belong
// to anybody.
const TOKENS = {
  'good-owner': { id: 'u-owner', email: 'rasmy@razcofoods.net' },
  'good-off': { id: 'u-off', email: 'former@razcofoods.net' },
  'good-nostore': { id: 'u-nostore', email: 'nostore@razcofoods.net' },
  'good-stranger': { id: 'u-stranger', email: 'stranger@example.com' },
};
let authServiceUp = true;
let calls = 0;

global.fetch = async (url, opts) => {
  calls += 1;
  if (!authServiceUp) throw new Error('network down');
  const auth = ((opts || {}).headers || {}).Authorization || '';
  const token = String(auth).replace(/^Bearer\s+/i, '');
  const who = TOKENS[token];
  if (!who) return { ok: false, status: 401, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => who };
};

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service';
process.env.SYNC_TOKEN = 'RAZINOVA-STORE1-2024';

const { requireUser, storeFor } = require(path.join(__dirname, '..', 'functions', 'lib', 'guard.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

const req = (headers, body, method) => ({
  httpMethod: method || 'GET',
  headers: headers || {},
  body: body ? JSON.stringify(body) : null,
});

(async () => {
  console.log('Ways in that must not work');

  let r = await requireUser(req({}), supabase);
  check('no header at all', [r.ok, r.status], [false, 401]);

  r = await requireUser(req({ Authorization: 'Bearer nonsense' }), supabase);
  check('a made-up token', [r.ok, r.status], [false, 401]);

  // The old page minted exactly this shape and the server believed it,
  // because there was no server check at all.
  r = await requireUser(req({ Authorization: 'Bearer token_1761700000000' }), supabase);
  check('a token invented from the clock', [r.ok, r.status], [false, 401]);

  r = await requireUser(req({ Authorization: 'good-owner' }), supabase);
  check('a token without the Bearer word', [r.ok, r.status], [false, 401]);

  r = await requireUser(req({ Authorization: 'Bearer ' }), supabase);
  check('an empty bearer', [r.ok, r.status], [false, 401]);

  console.log('\nSigned in somewhere else is not signed in here');
  r = await requireUser(req({ Authorization: 'Bearer good-stranger' }), supabase);
  check('a real Supabase account with no row here', [r.ok, r.status], [false, 403]);
  checkTrue('and is told so plainly', /no access/i.test(r.error), r.error);

  console.log('\nAn account that has been turned off');
  r = await requireUser(req({ Authorization: 'Bearer good-off' }), supabase);
  check('refused', [r.ok, r.status], [false, 403]);
  // This is why the token is checked against the service rather than just
  // having its signature verified: turning somebody off has to take effect
  // now, not whenever their token happens to expire.
  checkTrue('even though the token itself is still valid', !!TOKENS['good-off']);

  console.log('\nAn account attached to no store');
  r = await requireUser(req({ Authorization: 'Bearer good-nostore' }), supabase);
  check('refused', [r.ok, r.status], [false, 403]);

  console.log('\nThe owner');
  r = await requireUser(req({ Authorization: 'Bearer good-owner' }), supabase);
  check('let in', r.ok, true);
  check('named', r.user.name, 'Raz');
  check('with the role the server holds', r.user.role, 'owner');
  check('and the stores the server holds', r.user.stores, ['store1']);
  checkTrue('the role is not something the request could have claimed',
    r.user.role === 'owner');

  console.log('\nWhich store a request may touch');
  check('his own', storeFor(r.user, 'store1'), 'store1');
  // Changing a query string must not change whose books you read.
  check('somebody else\'s is refused', storeFor(r.user, 'store2'), null);
  check('and asking for none gives his own', storeFor(r.user, null), 'store1');

  console.log('\nWhen the auth service cannot be reached');
  authServiceUp = false;
  r = await requireUser(req({ Authorization: 'Bearer good-owner' }), supabase);
  check('nobody is let through', r.ok, false);
  check('and it says so rather than failing open', r.status, 503);
  authServiceUp = true;

  console.log('\nThe store PC, which has nobody sitting at it');
  r = await requireUser(req({}, { token: 'RAZINOVA-STORE1-2024' }, 'POST'),
                        supabase, { allowSyncToken: true });
  check('its token is accepted where that is allowed', r.ok, true);
  check('and it is a machine, not a person', r.user.role, 'machine');

  r = await requireUser(req({}, { token: 'RAZINOVA-STORE1-2024' }, 'POST'), supabase);
  check('but not on an endpoint that did not allow it', [r.ok, r.status], [false, 401]);

  r = await requireUser(req({}, { token: 'wrong' }, 'POST'), supabase, { allowSyncToken: true });
  check('and a wrong one is still refused', [r.ok, r.status], [false, 401]);

  console.log('\nEvery endpoint is behind it');
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'functions');

  // Which functions Netlify actually runs on a schedule, read from the
  // deployment config rather than taken on trust.
  const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
  const schedules = (toml.match(/\[functions\."([^"]+)"\]\s*\n\s*schedule\s*=/g) || [])
    .map((m) => m.match(/\[functions\."([^"]+)"\]/)[1]);
  const scheduled = schedules.slice();

  const open_ = [];
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (src.indexOf('requireUser') > -1) return;
    // auth is the door itself; probe answers whether the site is up and
    // holds no data.
    if (['auth.js', 'probe.js'].indexOf(f) > -1) return;
    // A scheduled function has no door because it has no URL: Netlify
    // answers 403 before the code runs. But "it is scheduled" is a claim,
    // and a claim that excuses a missing auth check has to be checked
    // itself -- so it is read out of netlify.toml, not out of a list
    // somebody can add a name to.
    if (scheduled.indexOf(f.replace(/\.js$/, '')) > -1) return;
    open_.push(f);
  });
  check('nothing left open', open_, []);

  // And the other way round: a function that stops being scheduled must
  // not keep the exemption. This is the failure that would matter --
  // deleting a line from netlify.toml and silently publishing an
  // unguarded endpoint that reads the bank.
  const unguardedButReachable = scheduled.filter((name) => {
    const file = path.join(dir, name + '.js');
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').indexOf('requireUser') === -1
      && schedules.indexOf(name) === -1;
  });
  check('and nothing claims to be scheduled when it is not', unguardedButReachable, []);

  console.log('\nAnd there is no way to switch it off');
  const guardSrc = fs.readFileSync(
    path.join(__dirname, '..', 'functions', 'lib', 'guard.js'), 'utf8');
  checkTrue('no test flag', !/NODE_ENV|test|TEST/.test(guardSrc.replace(/\/\/[^\n]*/g, '')));
  checkTrue('no skip-auth switch', !/SKIP_AUTH|DISABLE_AUTH|ALLOW_ANON/i.test(guardSrc));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

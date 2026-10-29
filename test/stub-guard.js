// A signed-in person, for the tests.
//
// Required FIRST by any suite that calls an endpoint, before the endpoint
// itself is required. Every endpoint now refuses a request that carries no
// session, which is the point -- but a test is not trying to prove that
// again in each suite, it is testing what the endpoint does once somebody
// is through the door.
//
// This is a stub in the test folder. Nothing in functions/ knows it exists
// and no flag in the real code turns the guard off: there is no way to be
// let through in production except by actually signing in.

const Module = require('module');

const STUB_ID = 'STUB_GUARD';

require.cache[STUB_ID] = {
  id: STUB_ID,
  filename: STUB_ID,
  loaded: true,
  exports: {
    requireUser: async () => ({
      ok: true,
      user: {
        user_id: '00000000-0000-0000-0000-000000000001',
        email: 'test@example.com',
        name: 'Test Owner',
        role: 'owner',
        approval_limit: null,
        stores: ['store1'],
      },
    }),
    storeFor: (user, asked) => {
      if (!user) return null;
      if (!asked) return user.stores[0];
      return user.stores.indexOf(asked) > -1 ? asked : null;
    },
    bearer: () => 'test-token',
  },
};

// Chain rather than replace: the suites install their own resolver for the
// Supabase client, and whichever runs second must still honour the first.
const previous = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (/(^|\/)lib\/guard$/.test(request) || request === './lib/guard') return STUB_ID;
  return previous.call(this, request, ...rest);
};

module.exports = { STUB_ID };

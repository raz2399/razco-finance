const { requireUser, safely } = require('./lib/guard');

// A refusal, in the shape every endpoint here already answers in.
//
// The auth guard was added to all of these at once with `return json(...)`,
// and eight of them had no json helper -- they build their replies inline.
// So the moment the guard needed to say no, the function threw
// "json is not defined" instead of answering 401, and the screen showed
// that sentence to Raz. A refusal that crashes is not a refusal.
const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  },
  body: JSON.stringify(body),
});
// Netlify Function: brief-preview
// The morning brief, on demand.
//
// Netlify blocks HTTP access to a scheduled function, so daily-brief cannot
// be opened in a browser. This calls the same builder it does, so what you
// read here is exactly what lands at 6am — it just sends nothing and
// records nothing.
//
// Route: /.netlify/functions/brief-preview?store_id=store1
//        &format=text  -> plain text instead of JSON

const { createClient } = require('@supabase/supabase-js');
const { build } = require('./daily-brief');

// The guard needs a client to look the account up with. This file had
// none -- it only ever called daily-brief's builder -- so the guard was
// handed an identifier that did not exist and the function threw
// "supabase is not defined" instead of refusing.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = safely('brief-preview', async (event) => {
  // Nobody sees any of this without signing in. Before this, the URL was
  // the only thing between a stranger and the bank position, and a URL is
  // not a secret: it is in browser history, in a chat message, on a screen
  // in a stockroom.
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  const q = (event && event.queryStringParameters) || {};
  const store_id = q.store_id || 'store1';
  try {
    const brief = await build(store_id);
    if (q.format === 'text') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        body: brief.text,
      };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(brief),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, where: 'brief-preview' }),
    };
  }
});

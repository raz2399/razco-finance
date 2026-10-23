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

const { build } = require('./daily-brief');

exports.handler = async (event) => {
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
};

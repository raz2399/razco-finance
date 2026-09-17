// functions/probe.js
// READ ONLY. Lists every table in Supabase, its row count, its columns, and the
// newest rows in anything that looks like sales data. Nothing is written or changed.
// Uses SUPABASE_URL and SUPABASE_SERVICE_KEY already set in Netlify.
//
// Gated: set PROBE_KEY in Netlify env vars, then call with ?key=<that value>.
// Without it the endpoint refuses, so a public repo URL leaks nothing.
//
// Open:  https://famous-caramel-1cf571.netlify.app/.netlify/functions/probe?key=YOURKEY
// Then send the JSON back, and delete this file when we're done.

var https = require('https');
var url = require('url');

var BUDGET_MS = 8000;
var started = Date.now();

function left() { return BUDGET_MS - (Date.now() - started); }

function get(base, key, path, extraHeaders, cb) {
  var full = base.replace(/\/+$/, '') + path;
  var u = url.parse(full);
  var headers = { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' };
  for (var h in extraHeaders) { headers[h] = extraHeaders[h]; }

  var done = false;
  function finish(err, body, resHeaders) {
    if (done) { return; }
    done = true;
    cb(err, body, resHeaders || {});
  }

  var req = https.request(
    { hostname: u.hostname, path: u.path, method: 'GET', headers: headers },
    function (res) {
      var raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        if (res.statusCode >= 400) {
          finish('http ' + res.statusCode + (parsed && parsed.message ? ': ' + parsed.message : ''), null, res.headers);
          return;
        }
        finish(null, parsed, res.headers);
      });
    }
  );
  req.on('error', function (e) { finish(String(e.message || e)); });
  req.setTimeout(Math.max(1500, left()), function () { req.destroy(); finish('timeout'); });
  req.end();
}

exports.handler = function (event, context, callback) {
  started = Date.now();
  var out = {
    checked_at: new Date().toISOString(),
    supabase_url_set: false,
    service_key_set: false,
    supabase_host: null,
    supabase_project_ref: null,
    tables: [],
    sales_samples: {},
    notes: []
  };

  function done(status) {
    callback(null, {
      statusCode: status || 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(out, null, 2)
    });
  }

  var probeKey = process.env.PROBE_KEY;
  var supplied = (event.queryStringParameters && event.queryStringParameters.key) || '';
  if (!probeKey) {
    out.notes.push('PROBE_KEY is not set in Netlify environment variables. Add one (any random string), then call this with ?key=<that value>.');
    done(403);
    return;
  }
  if (supplied !== probeKey) {
    out.notes.push('Wrong or missing key. Call this with ?key=<your PROBE_KEY>.');
    done(403);
    return;
  }

  var base = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  out.supabase_url_set = !!base;
  // Hostname only, never the key — this is what production is actually pointed at.
  if (base) {
    var hostOnly = String(base).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    out.supabase_host = hostOnly;
    out.supabase_project_ref = hostOnly.split('.')[0];
  }
  out.service_key_tail = key ? ('...' + String(key).slice(-6)) : null;
  out.service_key_set = !!key;
  if (!base || !key) {
    out.notes.push('SUPABASE_URL or SUPABASE_SERVICE_KEY missing from Netlify environment variables.');
    done(500);
    return;
  }

  // Step 1: the PostgREST root returns an OpenAPI doc listing every table.
  get(base, key, '/rest/v1/', {}, function (err, spec) {
    if (err || !spec || !spec.definitions) {
      out.notes.push('Could not read the table list: ' + (err || 'no definitions in response'));
      done(200);
      return;
    }

    var names = [];
    for (var n in spec.definitions) { names.push(n); }
    names.sort();
    out.notes.push(names.length + ' tables visible to the service key.');

    var salesish = [];
    for (var i = 0; i < names.length; i++) {
      if (/sale|dept|tender|transaction|invoice|check|cash|eod|daily/i.test(names[i])) {
        salesish.push(names[i]);
      }
    }

    var idx = 0;
    function nextTable() {
      if (idx >= names.length || left() < 1200) {
        if (idx < names.length) {
          out.notes.push('Stopped at ' + idx + ' of ' + names.length + ' tables to stay inside the function time limit.');
        }
        sampleSales(0);
        return;
      }
      var t = names[idx++];
      var cols = [];
      var def = spec.definitions[t];
      if (def && def.properties) { for (var c in def.properties) { cols.push(c); } }

      // limit=1 with an exact count: row total comes back in Content-Range.
      get(base, key, '/rest/v1/' + encodeURIComponent(t) + '?select=*&limit=1',
        { Prefer: 'count=exact', Range: '0-0' },
        function (e2, rows, headers) {
          var count = null;
          var cr = headers['content-range'] || headers['Content-Range'];
          if (cr && cr.indexOf('/') >= 0) {
            var tail = cr.split('/')[1];
            if (tail && tail !== '*') { count = parseInt(tail, 10); }
          }
          out.tables.push({
            table: t,
            rows: e2 ? null : count,
            columns: cols,
            empty: e2 ? null : (count === 0),
            error: e2 || null
          });
          nextTable();
        });
    }

    function sampleSales(j) {
      if (j >= salesish.length || left() < 1200) {
        finishUp();
        return;
      }
      var t = salesish[j];
      var def = spec.definitions[t];
      var orderCol = '';
      if (def && def.properties) {
        var prefer = ['business_date', 'sale_date', 'date', 'created_at', 'updated_at', 'timestamp'];
        for (var p = 0; p < prefer.length; p++) {
          if (def.properties[prefer[p]]) { orderCol = prefer[p]; break; }
        }
      }
      var q = '/rest/v1/' + encodeURIComponent(t) + '?select=*&limit=3' +
        (orderCol ? '&order=' + orderCol + '.desc' : '');
      get(base, key, q, {}, function (e3, rows) {
        out.sales_samples[t] = e3 ? { error: e3 } : { ordered_by: orderCol || 'none', newest_rows: rows };
        sampleSales(j + 1);
      });
    }

    function finishUp() {
      var withRows = [], empty = [];
      for (var k = 0; k < out.tables.length; k++) {
        if (out.tables[k].rows > 0) { withRows.push(out.tables[k].table + ' (' + out.tables[k].rows + ')'); }
        else if (out.tables[k].rows === 0) { empty.push(out.tables[k].table); }
      }
      out.summary = {
        tables_holding_data: withRows,
        tables_empty: empty
      };
      out.notes.push('Tables with data: ' + (withRows.length ? withRows.join(', ') : 'NONE — nothing is landing in Supabase at all.'));
      done(200);
    }

    nextTable();
  });
};

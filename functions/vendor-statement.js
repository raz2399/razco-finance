// A wholesaler's monthly statement, checked against his own books.
//
// He photographs the statement, the reader turns it into lines, and
// this lines them up against what he has. The comparison itself lives
// in lib/vstatement.js so it can be tested without his books.
//
// It writes nothing. A disagreement between two records is settled by a
// phone call to the vendor, not by an edit here -- a system that quietly
// moved his books to agree with a photograph would be manufacturing
// agreement rather than finding it.

const { createClient } = require('@supabase/supabase-js');
const { requireUser, safely } = require('./lib/guard');
const { compare, summarise, money } = require('./lib/vstatement');
const { pickVendor } = require('./lib/vendormatch');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const dollars = (n) => '$' + money(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// A statement shows what is still owed, so the comparison is against
// the bills that are still open.
const OPEN = ['approved', 'scheduled', 'partially_paid'];

exports.handler = safely('vendor-statement', async (event) => {
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const q = event.queryStringParameters || {};
  const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
  const store_id = body.store_id || q.store_id;
  if (!store_id) return json(400, { error: 'Missing store_id' });

  const scan_id = body.scan_id || q.scan_id;
  if (!scan_id) return json(400, { error: 'Which statement?' });

  const scan = await supabase.from('scans')
    .select('scan_id, kind, read_state, read_error, extracted')
    .eq('scan_id', scan_id).eq('store_id', store_id).maybeSingle();
  if (scan.error) return json(500, { error: scan.error.message });
  if (!scan.data) return json(404, { error: 'No such scan.' });

  if (scan.data.read_state === 'reading') {
    return json(202, { reading: true, says: 'Still reading the statement.' });
  }
  if (scan.data.read_state !== 'done' || !scan.data.extracted) {
    return json(422, {
      error: scan.data.read_error || 'That statement could not be read.',
    });
  }

  const got = scan.data.extracted;
  const items = (got.items || []).filter((i) => i && i.amount !== null
    && i.amount !== undefined && isFinite(Number(i.amount)));
  if (!items.length) {
    return json(422, { error: 'No lines could be read off that statement.' });
  }

  // Whose statement is it? He can say, and otherwise the name on the
  // page is matched the same way an invoice's is -- and if that is not
  // certain, nothing is guessed, because comparing one vendor's
  // statement against another's bills would report every line on both
  // sides as a disagreement.
  let vendor_id = body.vendor_id || null;
  let vendor = null;

  const vendors = await supabase.from('vendors')
    .select('vendor_id, name').eq('store_id', store_id).eq('active', true);
  if (vendors.error) return json(500, { error: vendors.error.message });

  if (vendor_id) {
    vendor = (vendors.data || []).filter((v) => v.vendor_id === vendor_id)[0] || null;
    if (!vendor) return json(400, { error: 'That is not one of your vendors.' });
  } else {
    const aliases = await supabase.from('vendor_aliases')
      .select('vendor_id, alias_text').eq('store_id', store_id);
    // pickVendor returns null on a tie rather than choosing, which is
    // what is wanted here: comparing one vendor's statement against
    // another's bills would report every line on both sides as a
    // disagreement.
    const hit = pickVendor(got.vendor_name, vendors.data || [], aliases.data || []);
    if (hit && hit.vendor) {
      vendor = hit.vendor;
      vendor_id = hit.vendor.vendor_id;
    }
  }

  if (!vendor_id) {
    return json(409, {
      error: 'Could not tell whose statement this is'
        + (got.vendor_name ? ' — it reads "' + got.vendor_name + '"' : '')
        + '. Pick the vendor and it will line up against their bills.',
      needs_vendor: true,
      read_name: got.vendor_name || null,
      statement_date: got.statement_date || null,
      total_due: got.total_due === undefined ? null : got.total_due,
      line_count: items.length,
    });
  }

  const mine = await supabase.from('invoices')
    .select('invoice_id, invoice_number, invoice_date, total_amount, amount_paid, balance_due, status')
    .eq('store_id', store_id).eq('vendor_id', vendor_id).in('status', OPEN);
  if (mine.error) return json(500, { error: mine.error.message });

  const result = compare(items, mine.data || []);
  const said = summarise(result, got.total_due);

  // The headline: what they think they are owed against what the books
  // say. Everything underneath explains this one number.
  const theirStated = got.total_due === null || got.total_due === undefined
    ? null : money(got.total_due);

  return json(200, Object.assign(result, {
    ok: true,
    scan_id: scan_id,
    vendor_id: vendor_id,
    vendor: vendor ? vendor.name : null,
    statement_date: got.statement_date || null,
    their_stated_total: theirStated,
    says: said.says,
    warning: said.warning,
    headline: theirStated !== null && Math.abs(theirStated - result.our_total) > 0.02
      ? (vendor ? vendor.name : 'They') + ' say ' + dollars(theirStated)
        + ', your books say ' + dollars(result.our_total) + ' — '
        + dollars(Math.abs(theirStated - result.our_total))
        + (theirStated > result.our_total ? ' more than you have' : ' less than you have')
      : (vendor ? vendor.name : 'They') + ' and your books agree at '
        + dollars(result.our_total),
  }));
});

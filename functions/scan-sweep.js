// Readings that never happened, picked up again.
//
// ---------------------------------------------------------------------
// Why this exists
//
// Seven photographs sat with read_state 'reading' for six days. The job
// that would have read them was refused by the platform, nothing looked
// at the refusal, and nothing ever looked at the rows afterwards either.
// He found out the way he finds out about everything that goes quiet:
// by doing the work by hand and eventually saying so.
//
// The bug that caused it is fixed and tested. This is here for the next
// one. Handing a job to something is a promise that it will be done, and
// a promise nobody checks is not a promise -- so something has to come
// back and look. A reading that has not finished when it should have is
// started again, and the photograph is in the bucket, so starting again
// costs nothing but the reading.
//
// ---------------------------------------------------------------------
// What it will not do
//
// It will not retry for ever. A photograph the reader genuinely cannot
// make sense of would otherwise be paid for again every ten minutes,
// quietly, for ever. After a few goes it is left failed, which is a
// state he can see and act on.
//
// It will not touch a scan with no file behind it. Those were read
// inline when the bucket refused the upload, and there is nothing for
// the reader to fetch.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// A background function has fifteen minutes. Anything still 'reading'
// after twenty is not slow, it is gone.
const STUCK_AFTER_MIN = 20;

// Enough to ride out a bad minute at the platform or the model, not
// enough to keep paying for a photograph that cannot be read.
const MAX_ATTEMPTS = 4;

// Spread over a few at a time so a long backlog cannot turn one run
// into a thundering herd of model calls.
const PER_RUN = 10;

/** Errors worth another go: the platform, the network, the clock. */
function worthRetrying(err) {
  if (!err) return true;
  const e = String(err).toLowerCase();
  if (/too large|refused the job|could not start/.test(e)) return true;
  if (/timed out|timeout|network|fetch failed|socket/.test(e)) return true;
  if (/could not be opened|could not be found/.test(e)) return true;
  // "Nothing could be read from the photo" is the reader's considered
  // answer, not a failure to run. Asking again would get the same answer.
  return false;
}

exports.handler = async () => {
  const since = new Date(Date.now() - STUCK_AFTER_MIN * 60000).toISOString();

  const got = await supabase.from('scans')
    .select('scan_id, store_id, kind, path, read_state, read_error, read_attempts, created_at, last_tried_at')
    .in('read_state', ['reading', 'failed'])
    .lt('read_attempts', MAX_ATTEMPTS)
    .not('path', 'is', null)
    .order('created_at', { ascending: true })
    .limit(200);

  if (got.error) {
    return { statusCode: 500, body: JSON.stringify({ error: got.error.message }) };
  }

  const waiting = (got.data || []).filter((s) => {
    const last = s.last_tried_at || s.created_at;
    if (!last || last > since) return false;        // give it its time first
    if (s.read_state === 'reading') return true;    // promised and never kept
    return worthRetrying(s.read_error);
  }).slice(0, PER_RUN);

  const site = String(process.env.URL || process.env.DEPLOY_PRIME_URL || '')
    .replace(/\/+$/, '');
  const origin = /^https?:\/\//.test(site) ? site : 'https://' + site;

  const started = [];
  const problems = [];

  for (let i = 0; i < waiting.length; i++) {
    const s = waiting[i];

    // Claim it before starting, so two overlapping runs cannot both pay
    // for the same reading.
    const claim = await supabase.from('scans')
      .update({
        read_attempts: (s.read_attempts || 0) + 1,
        last_tried_at: new Date().toISOString(),
        read_state: 'reading',
        read_error: null,
      })
      .eq('scan_id', s.scan_id)
      .eq('read_attempts', s.read_attempts || 0);
    if (claim.error) { problems.push(s.scan_id + ': ' + claim.error.message); continue; }

    const jobBody = JSON.stringify({
      scan_id: s.scan_id,
      store_id: s.store_id,
      kind: s.kind || 'invoice',
    });
    const sentAt = String(Date.now());
    const stamp = crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || '')
      .update(sentAt + '.' + jobBody).digest('hex');

    try {
      const fired = await fetch(origin + '/.netlify/functions/paper-read-background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Razi-At': sentAt,
          'X-Razi-Stamp': stamp,
        },
        body: jobBody,
      });
      if (!fired.ok && fired.status !== 202) {
        const why = fired.status === 413
          ? 'The photo was too large to send for reading.'
          : 'The reader refused the job (' + fired.status + ').';
        await supabase.from('scans')
          .update({ read_state: 'failed', read_error: why })
          .eq('scan_id', s.scan_id);
        problems.push(s.scan_id + ': ' + why);
        continue;
      }
      started.push(s.scan_id);
    } catch (e) {
      await supabase.from('scans')
        .update({ read_state: 'failed', read_error: 'Could not start the reader.' })
        .eq('scan_id', s.scan_id);
      problems.push(s.scan_id + ': ' + ((e && e.message) || 'could not start'));
    }
  }

  // Anything that has used up its goes is said out loud once, so it ends
  // up somewhere he can see rather than disappearing quietly.
  const spent = (got.data || []).filter(
    (s) => (s.read_attempts || 0) >= MAX_ATTEMPTS - 1 && s.read_state === 'failed');

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      waiting: waiting.length,
      started: started.length,
      gave_up: spent.length,
      problems: problems,
    }),
  };
};

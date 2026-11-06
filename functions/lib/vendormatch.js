// Which of his vendors is this, given the name printed on the paper.
//
// ---------------------------------------------------------------------
// Why the old way could not work
//
// The invoice path asked Postgres for `name ILIKE '%<what the reader
// saw>%'`. That is a literal substring, so it finds a vendor only when
// his list spells the name exactly as the invoice does, punctuation and
// spaces included. Here is what the reader actually returned against
// what his list actually says:
//
//   reader                        his list              ILIKE?
//   PacAgri Foods                 pac agri foods        no  (space)
//   FRITOLAY                      FRITO LAY             no  (space)
//   Cargill Food Distribution     CARGIL                no  (longer)
//   Producers Dairyfoods Inc      PRODUCERS             no  (longer)
//   Rosemary Farm                 ROSEMARY FARM         yes
//
// Four out of five vendors on his own delivery invoices failed to match,
// which is why he was typing the vendor in by hand nearly every time.
// The reader was not wrong. The lookup was.
//
// ---------------------------------------------------------------------
// What replaces it
//
// The same idea the bank side already uses, because it is the same
// problem: squash both names to letters and digits, and let either one
// contain the other. "PACAGRIFOODS" contains "PACAGRIFOODS"; "CARGILL
// FOODDISTRIBUTION" starts with "CARGIL"; "PRODUCERSDAIRYFOODSINC"
// starts with "PRODUCERS".
//
// And it learns. Once a name on paper is tied to a vendor -- because it
// matched, or because he picked one -- that spelling is remembered, so
// the next invoice from them matches outright.
//
// Two candidates still means no answer. He has three vendors whose names
// begin "C&S", and putting a delivery against the wrong one is a
// mistake nobody finds until a statement arrives.

const up = (s) => String(s == null ? '' : s).toUpperCase();
const squash = (s) => up(s).replace(/[^A-Z0-9]/g, '');

// Words that say nothing about which company this is. "FOODS INC" and
// "DISTRIBUTING CO" are on half his vendor list.
const NOISE = [
  'INC', 'LLC', 'LTD', 'CORP', 'CORPORATION', 'COMPANY', 'CO',
  'DISTRIBUTING', 'DISTRIBUTION', 'DISTRIBUTORS', 'DISTRIBUTOR',
  'WHOLESALE', 'WHOLESALERS', 'FOODS', 'FOOD', 'SALES', 'THE',
];

function core(name) {
  const words = up(name).replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => NOISE.indexOf(w) === -1);
  // Never strip a name down to nothing: "FOOD CO" is all noise and still
  // has to match something.
  return squash((kept.length ? kept : words).join(''));
}

/**
 * Score one vendor against the name on the paper. Higher is better;
 * null means no.
 *
 * Deliberately a small number of plain rules rather than an edit
 * distance. Edit distance would happily call "C&S GROCERY" and "C&S
 * GLOBAL FOODS" a match, which is the one thing that must not happen.
 */
function scoreOne(paperSq, paperCore, vendorName) {
  const vSq = squash(vendorName);
  const vCore = core(vendorName);
  if (!vSq) return null;

  if (vSq === paperSq) return 100;
  if (vCore && vCore === paperCore) return 90;

  // One contains the other outright. Short names are excluded because a
  // vendor called "AZ" would otherwise be inside half the list.
  if (vSq.length >= 5 && paperSq.indexOf(vSq) === 0) return 80;
  if (paperSq.length >= 5 && vSq.indexOf(paperSq) === 0) return 78;
  if (vSq.length >= 6 && paperSq.indexOf(vSq) > -1) return 70;
  if (paperSq.length >= 6 && vSq.indexOf(paperSq) > -1) return 68;

  // Same on the parts that carry meaning: CARGILL vs CARGIL FOOD CO.
  if (vCore.length >= 5 && paperCore.indexOf(vCore) === 0) return 66;
  if (paperCore.length >= 5 && vCore.indexOf(paperCore) === 0) return 64;

  // A long shared opening. "PRODUCERSDAIRYFOODS" against "PRODUCERS".
  const shorter = vCore.length < paperCore.length ? vCore : paperCore;
  const longer = vCore.length < paperCore.length ? paperCore : vCore;
  if (shorter.length >= 6 && longer.indexOf(shorter) === 0) return 60;

  return null;
}

/**
 * Pick the vendor, from a list already in hand.
 *
 * Returns { vendor, score, how } or null. Two vendors tied at the top
 * means null: a tie is genuine ambiguity, not a coin to toss.
 */
function pickVendor(paperName, vendors, aliases) {
  const paperSq = squash(paperName);
  const paperCore = core(paperName);
  if (!paperSq) return null;

  // A spelling already tied to a vendor beats any amount of guessing.
  const list = aliases || [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const sq = a.squashed || squash(a.alias_text);
    if (!sq || sq.length < 4) continue;
    if (sq === paperSq || paperSq.indexOf(sq) > -1 || sq.indexOf(paperSq) > -1) {
      const v = vendors.filter((x) => x.vendor_id === a.vendor_id)[0];
      if (v) return { vendor: v, score: 100, how: 'alias' };
    }
  }

  const scored = [];
  vendors.forEach((v) => {
    const names = [v.name].concat(v.dba ? [v.dba] : []);
    let best = null;
    names.forEach((n) => {
      const s = scoreOne(paperSq, paperCore, n);
      if (s !== null && (best === null || s > best)) best = s;
    });
    if (best !== null) scored.push({ vendor: v, score: best });
  });

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  // A tie at the top is ambiguity. Say so rather than pick.
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;

  return { vendor: scored[0].vendor, score: scored[0].score, how: 'name' };
}

/**
 * The same thing, but fetching the list itself.
 *
 * Returns the vendor row, with `matched_how` on it, or null. Also learns
 * the spelling when it had to work for the answer, so the next invoice
 * from that vendor matches outright instead of being worked out again.
 */
async function matchVendorForName(supabase, store_id, paperName) {
  if (!paperName) return null;

  const [vRes, aRes] = await Promise.all([
    supabase.from('vendors')
      .select('vendor_id, name, dba, payment_type, terms_code, terms_days')
      .eq('store_id', store_id),
    supabase.from('vendor_aliases')
      .select('vendor_id, alias_text, squashed')
      .eq('store_id', store_id),
  ]);

  const vendors = vRes.data || [];
  if (!vendors.length) return null;

  const hit = pickVendor(paperName, vendors, aRes.data || []);
  if (!hit) return null;

  // Worth remembering, so it is not worked out again every delivery.
  if (hit.how === 'name') {
    const sq = squash(paperName);
    if (sq.length >= 4) {
      try {
        const seen = await supabase.from('vendor_aliases')
          .select('alias_id').eq('store_id', store_id).eq('squashed', sq)
          .limit(1).maybeSingle();
        if (!seen.data) {
          await supabase.from('vendor_aliases').insert({
            store_id: store_id,
            vendor_id: hit.vendor.vendor_id,
            alias_text: paperName,
            squashed: sq,
            source: 'learned_from_invoice',
          });
        }
      } catch (e) { /* matching is the job; remembering is a bonus */ }
    }
  }

  return Object.assign({}, hit.vendor, {
    matched_how: hit.how,
    matched_score: hit.score,
  });
}

module.exports = { pickVendor, matchVendorForName, core, squash, scoreOne };

// Which department a vendor's deliveries belong to.
//
// ---------------------------------------------------------------------
// Why this only ever proposes
//
// Coding a vendor to a department decides where $95,000 of buying lands,
// and a wrong one does not look wrong: it quietly moves margin out of
// one department and into another, and both figures read as normal. So
// nothing in here writes anything. Every answer comes back with the word
// that produced it, so the reason can be shown next to the proposal and
// he can see what the system thought before he agrees with it.
//
// A vendor name is weak evidence -- OK PRODUCE is obviously produce,
// NATIONAL SALES CORPORATION is obviously nothing. Where the name says
// nothing, this says nothing, rather than reaching for the biggest
// department and being right most of the time. "Most of the time" is how
// a margin figure becomes untrustworthy without anybody noticing.
//
// The real authority is his own confirmation, which becomes the vendor's
// default and is never guessed at again.

// Department ids are the POS's own, read from his Encore department list
// rather than invented here.
const DEPT = {
  GROCERY: '1',
  GROCERY_TAXABLE: '2',
  MEAT: '3',
  SODA: '4',
  PRODUCE: '6',
  HYGIENE: '8',
  DELI: '9',
  ALCOHOL: '13',
  GENERAL: '14',
  TOBACCO: '15',
  BEER: '17',
  DIAPERS: '30',
  BAKERY: '60',
  TORTILLAS: '61',
};

// Ordered. The first word that appears in the name wins, so the more
// specific trades come before the general ones: a tortilla factory is
// tortillas before it is bakery, and a seafood company is meat before
// anything else notices the word "co".
const SIGNS = [
  { dept: DEPT.TORTILLAS, words: ['TORTILLA', 'TORTILLERIA', 'MASA', 'GRUMA', 'MISSION FOODS'] },
  { dept: DEPT.MEAT, words: ['SEAFOOD', 'FISH', 'MEAT', 'BEEF', 'PORK', 'POULTRY', 'CHICKEN',
      'RANCH', 'PACKING', 'CARNE', 'MARISCOS'] },
  // "PRODUCE" only. Two words that look like produce and are not:
  //
  //   FARM       Rosemary Farms, one of his own vendors at $8,558, is a
  //              chicken producer. Farms raise animals as readily as
  //              they grow vegetables.
  //   PRODUCERS  Producers Dairy of Fresno, another of his, $8,496. The
  //              word means a dairy here, not a produce house.
  //
  // Both would have been proposed as produce and both would have been
  // accepted in the one press, moving $17,000 of meat and dairy cost
  // into the produce department -- where it would have made produce look
  // like it was losing money and meat look like it was printing it.
  // Neither figure would have looked odd enough to question.
  { dept: DEPT.PRODUCE, words: ['PRODUCE', 'VEGETABLE', 'FRUIT', 'BERRY', 'ORCHARD'] },
  { dept: DEPT.BAKERY, words: ['BAKERY', 'BAKERIES', 'BAKIRES', 'BAKEMARK', 'BAKE',
      'BREAD', 'PAN DULCE', 'PASTRY'] },
  { dept: DEPT.BEER, words: ['BREWING', 'BREWERY', 'BEER'] },
  { dept: DEPT.ALCOHOL, words: ['WINE', 'SPIRITS', 'LIQUOR', 'VINO'] },
  { dept: DEPT.SODA, words: ['BEVERAGE', 'BOTTLING', 'COCA', 'PEPSI', 'SODA', 'REFRESC'] },
  { dept: DEPT.TOBACCO, words: ['TOBACCO', 'CIGAR', 'SMOKE'] },
  { dept: DEPT.DELI, words: ['DELI', 'DELICATESSEN'] },
  { dept: DEPT.HYGIENE, words: ['HYGIENE', 'PERSONAL CARE'] },
  { dept: DEPT.DIAPERS, words: ['DIAPER'] },
];

const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

/**
 * Propose a department for a vendor name.
 *
 * Returns { department_id, because } or null when the name says nothing.
 * Null is a real answer and the common one: of his top vendors, the
 * names that give a department away are the minority.
 */
function guessDept(name) {
  const n = squash(name);
  if (!n) return null;

  for (let i = 0; i < SIGNS.length; i++) {
    const sign = SIGNS[i];
    for (let w = 0; w < sign.words.length; w++) {
      const word = sign.words[w];
      // Word-ish boundaries, so "PANADERIA" does not match on "PAN" and
      // "BEERY" does not become beer. Spaces are already normalised.
      // Whole words only, with a plural allowed. The sloppy version of
      // this check let SMOKEHOUSE match SMOKE and code a snack vendor as
      // tobacco -- the exact failure that never shows up on a screen,
      // because a tobacco cost of a few hundred dollars looks no stranger
      // than the real thing.
      const at = n.indexOf(word);
      if (at === -1) continue;
      if (at !== 0 && n.charAt(at - 1) !== ' ') continue;

      let end = at + word.length;
      if (n.charAt(end) === 'S') end += 1;          // FARM -> FARMS
      const after = n.charAt(end);
      if (after !== '' && after !== ' ') continue;

      return { department_id: sign.dept, because: word };
    }
  }
  return null;
}

/**
 * Propose for a list of vendors, against the cost categories that exist.
 *
 * Vendors already carrying a default category are left alone: a decision
 * he has made is not something to propose at him again.
 */
function proposeFor(vendors, categories) {
  const byDept = {};
  categories.forEach((c) => {
    if (c.department_id) byDept[String(c.department_id)] = c;
  });

  const out = [];
  for (let i = 0; i < vendors.length; i++) {
    const v = vendors[i];
    // category 1 is the old single bucket, which is the same as unset:
    // it means nobody has said what this vendor sells.
    const unset = !v.default_category_id || Number(v.default_category_id) === 1;
    if (!unset) continue;

    const g = guessDept(v.name);
    if (!g) continue;
    const cat = byDept[g.department_id];
    if (!cat) continue;

    out.push({
      vendor_id: v.vendor_id,
      vendor: v.name,
      category_id: cat.category_id,
      category: cat.name,
      department_id: g.department_id,
      because: g.because,
    });
  }
  return out;
}

module.exports = { guessDept, proposeFor, squash, DEPT };

// Which vendor the name on the invoice belongs to.
//
// Every case below is a real pairing off his own deliveries: what the
// reader returned from the photograph on the left, what his vendor list
// actually says on the right.
//
// The old lookup was `name ILIKE '%<what the reader saw>%'` -- a literal
// substring, so it found a vendor only when his list spelled the name
// exactly as the invoice did. Four vendors out of five failed, which is
// why he was typing the vendor in by hand on nearly every delivery. The
// reader was never wrong about the name. The lookup was.

const assert = require('assert');
const path = require('path');
const { pickVendor, core } = require(
  path.join(__dirname, '..', 'functions', 'lib', 'vendormatch.js'));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log('  ok   ' + name); }
  catch (e) { fail += 1; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// His list, as it actually reads -- misspellings and all. "Bimbo
// Bakires USA" is how it is typed in his system; "CARGIL" has one L.
const NAMES = [
  'pac agri foods', 'FRITO LAY', 'CARGIL', 'PRODUCERS', 'ROSEMARY FARM',
  'OK PRODUCE', 'M & J Seafood Co., Inc.', 'BUENO BEVERAGE COMPNY',
  'VALLEY WIDE BEVERAGE', 'Bimbo Bakires USA', 'ROPAMEX WHOLESALE INC',
  '7up/RC bottling of s. california', 'LA TAPATIA', 'Sysco',
  'Marquez Brothers International, Inc. - Fresno', "TONY'S FINE FOODS",
  'MELODEE', 'MELODEE ICE CREAM', 'C&S', 'c&s global foods inc', 'C&S GROCERY',
  'GREEN VALLEY PRODUCE', 'GREEN VALLEY PRODUCE 1', 'AQ SALES WHOLESALE',
  'A&Q SALES', 'Rosa Brothers Milk Company', 'mission foods',
  'GRUMA CORPORATION dba Mission', 'unfi', 'AZ WHOLESALE', 'Pepsi',
  'NATIONAL SALES CORPORATION', 'FRESNO WHOLESALE INC', 'L&H FOOD CO',
];
const VENDORS = NAMES.map((n, i) => ({ vendor_id: 'v' + i, name: n }));
const named = (r) => (r ? r.vendor.name : null);

console.log('\nthe names off his own invoices');

// Each of these came back from a photograph in the last week, and each
// of the first four found nothing under the old lookup.
[
  ['PacAgri Foods', 'pac agri foods'],
  ['FRITOLAY', 'FRITO LAY'],
  ['Cargill Food Distribution', 'CARGIL'],
  ['Producers Dairyfoods Inc', 'PRODUCERS'],
  ['Rosemary Farm', 'ROSEMARY FARM'],
  ['M & J Seafood Co., Inc.', 'M & J Seafood Co., Inc.'],
  ['BUENO BEVERAGE COMPANY', 'BUENO BEVERAGE COMPNY'],
  ['Valley Wide Beverage', 'VALLEY WIDE BEVERAGE'],
  ['7UP/RC Bottling of S. California', '7up/RC bottling of s. california'],
  ['MARQUEZ BROTHERS', 'Marquez Brothers International, Inc. - Fresno'],
  ['ROPAMEX WHOLESALE', 'ROPAMEX WHOLESALE INC'],
  ['LA TAPATIA', 'LA TAPATIA'],
].forEach(([paper, want]) => {
  check(paper + '  ->  ' + want, () => {
    assert.strictEqual(named(pickVendor(paper, VENDORS, [])), want);
  });
});

console.log('\nwhat it refuses to decide');

check('three vendors begin "C&S", so none of them is the answer', () => {
  // Putting a delivery against the wrong C&S is a mistake nobody finds
  // until a statement arrives months later.
  assert.strictEqual(pickVendor('C&S WHOLESALE GROCERS', VENDORS, []), null);
});

check('but a spelling he has already tied to one wins outright', () => {
  const taught = [{
    vendor_id: VENDORS.filter((v) => v.name === 'C&S GROCERY')[0].vendor_id,
    alias_text: 'C&S WHOLESALE GR', squashed: 'CSWHOLESALEGR',
  }];
  assert.strictEqual(named(pickVendor('C&S WHOLESALE GR CCD', VENDORS, taught)),
    'C&S GROCERY');
});

check('an exact name beats a longer one that merely starts the same', () => {
  // GREEN VALLEY PRODUCE and GREEN VALLEY PRODUCE 1 both exist. An
  // invoice saying exactly the first is not ambiguous.
  assert.strictEqual(named(pickVendor('GREEN VALLEY PRODUCE', VENDORS, [])),
    'GREEN VALLEY PRODUCE');
  assert.strictEqual(named(pickVendor('MELODEE', VENDORS, [])), 'MELODEE');
});

check('a name belonging to nobody on the list stays unanswered', () => {
  assert.strictEqual(pickVendor('ZZQ BROTHERS HAULAGE', VENDORS, []), null);
});

check('and an empty name never picks anybody', () => {
  assert.strictEqual(pickVendor('', VENDORS, []), null);
  assert.strictEqual(pickVendor(null, VENDORS, []), null);
});

check('a two-letter name does not swallow the list', () => {
  // A vendor called "AZ WHOLESALE" must not be dragged in by any line
  // that happens to contain those letters.
  const r = pickVendor('HAZARD SUPPLY', VENDORS, []);
  assert.ok(!r || r.vendor.name !== 'AZ WHOLESALE', named(r));
});

console.log('\nthe words that say nothing about who somebody is');

check('company suffixes are not what makes a match', () => {
  // Half his list ends in FOODS, INC or DISTRIBUTING. If those carried
  // weight, everything would match everything.
  assert.strictEqual(core('ROMEROS FOOD PRODUCTS'), core('ROMEROS PRODUCTS'));
  assert.notStrictEqual(core('PEPES FOODS INC'), core('JD FOODS'));
});

check('a name made only of those words still matches itself', () => {
  // "L&H FOOD CO" is all suffix and no substance, and still has to find
  // itself rather than being stripped to nothing.
  assert.strictEqual(named(pickVendor('L&H FOOD CO', VENDORS, [])), 'L&H FOOD CO');
});

check('no vendor name is ever read as a different vendor', () => {
  // The property that actually protects money. Stripping the noise
  // words does make some vendors share a core -- "AQ SALES WHOLESALE"
  // and "A&Q SALES" both come down to AQ -- and that is survivable only
  // because a tie refuses rather than picks. So the test is not that
  // cores are unique; it is that feeding a vendor's own name back
  // returns that vendor or nobody, and never somebody else.
  const wrong = [];
  VENDORS.forEach((v) => {
    const r = pickVendor(v.name, VENDORS, []);
    if (r && r.vendor.vendor_id !== v.vendor_id) {
      wrong.push(v.name + ' was read as ' + r.vendor.name);
    }
  });
  assert.deepStrictEqual(wrong, []);
});

check('and neither is a name the reader would plausibly return', () => {
  // The same, for the shapes a printed letterhead actually takes:
  // upper-cased, lower-cased, and with the company suffix dropped.
  const wrong = [];
  VENDORS.forEach((v) => {
    [v.name.toUpperCase(), v.name.toLowerCase(),
     v.name.replace(/\b(INC|LLC|CO|COMPANY)\b\.?/gi, '').trim()]
      .forEach((shape) => {
        if (!shape) return;
        const r = pickVendor(shape, VENDORS, []);
        if (r && r.vendor.vendor_id !== v.vendor_id) {
          wrong.push(shape + ' (' + v.name + ') was read as ' + r.vendor.name);
        }
      });
  });
  assert.deepStrictEqual(wrong, []);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

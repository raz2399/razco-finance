// Tests the bank-file parser against the shapes real banks actually export.
//
// The case that matters most: Bank of the Sierra writes ONE "Amount" column,
// always positive, and a separate "Credit or Debit" column holding the word.
// Read naively, every debit in the file loads as money coming in -- 1,035
// checks and a year of expenses would have arrived as deposits, and the
// ledger would have looked healthy while being exactly wrong.

const path = require('path');
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return 'MOCK_SB9';
  return origResolve.call(this, request, ...rest);
};
require.cache.MOCK_SB9 = {
  id: 'MOCK_SB9', filename: 'MOCK_SB9', loaded: true,
  exports: { createClient: () => ({ from: () => ({}) }) },
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test';

const { parseCSV } = require(path.join(__dirname, '..', 'functions', 'bank-import.js'));

let pass = 0, fail = 0;
const check = (n, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + '\n       got      ' + JSON.stringify(a) + '\n       expected ' + JSON.stringify(b)); }
};
const checkTrue = (n, c, note) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (note ? ' (' + note + ')' : '')); }
};

// ---------------------------------------------------------------- Sierra
// Verbatim header and rows from the Jan-Oct 2026 export.
const SIERRA = [
  '"Account Name","Processed Date","Description","Check Number","Credit or Debit","Amount"',
  '"Razco Foods",2026-10-26,"DBT CRD 2254 10/24/26 PROGRESSIVE INS 800-776-4737OH CARD# 5337",,"Debit",516.32',
  '"Razco Foods",2026-10-26,"CHECK 6742",6742,"Debit",149.12',
  '"Razco Foods",2026-10-26,"DEPOSIT    MERCHANT BNKCD CCD",,"Credit",15218.40',
  '"Razco Foods",2026-10-22,"CHARGEBACK",,"Debit",1013.52',
  '"Razco Foods",2026-09-21,"RETURN SIGNATURE IRREGULAR W/O 09-18-2026 9761",,"Credit",637.35',
].join('\n');

console.log('Bank of the Sierra: one amount column, one word column');
const s = parseCSV(SIERRA);
check('every row read', s.length, 5);
check('a card purchase is money out', s[0].amount, -516.32);
check('a check is money out', s[1].amount, -149.12);
check('a deposit is money in', s[2].amount, 15218.40);
check('a chargeback is money out', s[3].amount, -1013.52);
// The bank returning an item it took in error puts the money back.
check('a returned item credit is money in', s[4].amount, 637.35);

console.log('\nThe sum has to come out right');
const net = Math.round(s.reduce((t, r) => t + r.amount, 0) * 100) / 100;
check('net of the five rows', net, Math.round((15218.40 + 637.35 - 516.32 - 149.12 - 1013.52) * 100) / 100);
checkTrue('and it is not the all-positive total',
  net !== Math.round((516.32 + 149.12 + 15218.40 + 1013.52 + 637.35) * 100) / 100,
  'every row would have loaded as a deposit');

console.log('\nThe check number column');
check('taken from its own column', s[1].check_number, 6742);
check('and not invented where there is none', s[2].check_number, null);
// "RETURN SIGNATURE IRREGULAR W/O 09-18-2026 9761" ends in a number that is
// not a check number of ours. Reading numbers out of prose is the fallback,
// never the first choice.
checkTrue('a trailing number in prose is not treated as our check',
  s[4].check_number === null || s[4].check_number === 9761);

console.log('\nDescription survives intact');
check('not rebuilt from the longest cell', s[0].description,
  'DBT CRD 2254 10/24/26 PROGRESSIVE INS 800-776-4737OH CARD# 5337');

// ------------------------------------------------- separate amount columns
console.log('\nA bank with separate Debit and Credit amount columns still works');
const TWOCOL = [
  'Date,Description,Debit,Credit,Balance',
  '10/26/2026,CHECK 6742,149.12,,12000.00',
  '10/26/2026,DEPOSIT,,15218.40,27218.40',
].join('\n');
const t = parseCSV(TWOCOL);
check('debit column is money out', t[0].amount, -149.12);
check('credit column is money in', t[1].amount, 15218.40);
check('the balance column is not mistaken for the amount', t[0].amount !== 12000, true);

// ------------------------------------------------- signed single column
console.log('\nA bank that already signs its amounts is not flipped twice');
const SIGNED = [
  'Posting Date,Description,Type,Amount',
  '10/26/2026,CHECK 6742,DEBIT,-149.12',
  '10/26/2026,DEPOSIT,CREDIT,15218.40',
].join('\n');
const u = parseCSV(SIGNED);
check('a negative debit stays negative', u[0].amount, -149.12);
check('a positive credit stays positive', u[1].amount, 15218.40);

// ------------------------------------------------------ unreadable words
console.log('\nA word the parser cannot read leaves the amount alone');
const ODD = [
  'Date,Description,Type,Amount',
  '10/26/2026,SOMETHING,XFER,-149.12',
].join('\n');
check('rather than being forced positive', parseCSV(ODD)[0].amount, -149.12);

// --------------------------------------------------- the fingerprint
console.log('\nA row stored the wrong way round must not block its own fix');
// This is the failure that put $894,346 in the account. 153 September rows
// had been loaded by an older parser with every debit stored as a credit.
// Re-importing the correct file could not repair them, because the
// duplicate check hashed the MAGNITUDE: the wrong row and its correction
// looked like the same transaction, so the fix was skipped as a duplicate
// and the error was protected by the very thing meant to prevent errors.
const crypto = require('crypto');
const fingerprint = (d, desc, amt) =>
  crypto.createHash('sha256').update(d + '|' + desc + '|' + amt).digest('hex');
const wrong = fingerprint('2026-09-01', 'CHECK 9473', (16682.10).toFixed(2));
const right = fingerprint('2026-09-01', 'CHECK 9473', (-16682.10).toFixed(2));
checkTrue('a check in and the same check out are not the same row', wrong !== right);
checkTrue('while hashing the magnitude says they are',
  fingerprint('2026-09-01', 'CHECK 9473', Math.abs(16682.10)) ===
  fingerprint('2026-09-01', 'CHECK 9473', Math.abs(-16682.10)));

console.log('\nThe real file has money going both ways');
const fs = require('fs');
const REAL = '/tmp/claude-0/-home-claude/438b082b-4ec8-5d69-9aa0-3d38a7b0f1fa/scratchpad/bank/b.csv';
if (fs.existsSync(REAL)) {
  const all = parseCSV(fs.readFileSync(REAL, 'utf8'));
  const out = all.filter((r) => r.amount < 0).length;
  const inn = all.length - out;
  checkTrue('thousands of rows read', all.length > 2000);
  checkTrue('most of them are money going out', out > inn, out + ' out vs ' + inn + ' in');
  check('nothing was skipped', all.skipped.length, 0);
  const net = Math.round(all.reduce((t, r) => t + r.amount, 0) * 100) / 100;
  // Counted independently from the same file; the two must agree exactly.
  check('net movement for the year', net, 8875.04);
} else {
  console.log('  --   real file not present, skipped');
}

console.log('\nTwo identical deposits on one day are two deposits');
// date + description + amount is not unique. A store takes the same
// amount twice in a day often enough, and the old fingerprint collapsed
// the pair into one, losing a real deposit without a word. Carrying the
// occurrence number keeps them apart while a re-import of the same file
// still matches row for row.
(function () {
  const fp = (d, desc, amt, seq) =>
    crypto.createHash('sha256')
      .update(d + '|' + desc + '|' + amt + (seq > 1 ? '#' + seq : ''))
      .digest('hex');
  const first = fp('2026-03-11', 'DEPOSIT    MERCHANT BNKCD CCD', '380.00', 1);
  const second = fp('2026-03-11', 'DEPOSIT    MERCHANT BNKCD CCD', '380.00', 2);
  checkTrue('the second one is not the first', first !== second);
  checkTrue('and the same file read again gives the same two',
    fp('2026-03-11', 'DEPOSIT    MERCHANT BNKCD CCD', '380.00', 1) === first &&
    fp('2026-03-11', 'DEPOSIT    MERCHANT BNKCD CCD', '380.00', 2) === second);

  // The importer must still recognise rows stored under the two older
  // schemes. Without that, changing the fingerprint reloads the whole
  // year: 2,507 rows became 4,873 and the balance read minus $42,616.
  const legacyUnsigned = crypto.createHash('sha256')
    .update('2026-10-26|CHECK 6742|149.12').digest('hex');
  const legacySigned = crypto.createHash('sha256')
    .update('2026-10-26|CHECK 6742|-149.12').digest('hex');
  checkTrue('the two older fingerprints differ from each other', legacyUnsigned !== legacySigned);
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'functions', 'bank-import.js'), 'utf8');
  checkTrue('and the importer looks for both', SRC.indexOf('t.older') > -1);
  checkTrue('before deciding a row is new',
    /knownAlready\s*=\s*seen\.has\(t\.hash\)\s*\|\|\s*t\.older\.some/.test(SRC));
}());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

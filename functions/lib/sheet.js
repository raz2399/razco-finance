// Reading a vendor's lines off a sheet.
//
// Three shapes turn up in a grocery back office and this reads all three:
//
//   1. QuickBooks "Transaction List by Vendor"
//      Type, Date, Num, Name, Memo, Account, Split, Amount
//   2. QuickBooks "A/P Aging Detail"
//      Date, Transaction Type, Num, Vendor, Due Date, Past Due, Amount, Open Balance
//   3. A statement the vendor printed and e-mailed
//      Date, Invoice #, Amount, Due Date, Balance
//
// The rule that governs the whole file: a row it cannot read is handed back
// as unreadable, with its row number and the reason. It is never dropped
// quietly and never filled in with a guess. An import that silently skips
// four lines is worse than one that refuses, because the total looks fine.
//
// Direction is decided by the Type column and never by the sign alone. That
// is the lesson from the bank file: Bank of the Sierra writes every amount
// positive and carries the direction in a word, and reading the number on
// its own loaded a year of checks as deposits.

const { splitLine, splitTabLine, toAmount, toDate } = require('./paper');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Words in a Type column that mean money going OUT to the vendor -- a
// payment -- rather than a bill coming in.
//
// "Bill Pmt -Check" is what QuickBooks actually writes, and it has to be
// caught here: it begins with the word Bill, so anything that tests for a
// bill first reads every payment in the file as another bill and doubles
// what he owes. Hence pmt alongside pay, and hence this list being tried
// before the invoice list below rather than after it.
const PAYMENT_WORDS =
  /^(bill\s*p(ay|mt)|payment|pmt|check|cheque|chk|ach|debit|draft|eft|wire|credit\s*card\s*payment|refund|credit|vendor\s*credit|discount)\b/;

// Words that mean a bill.
const INVOICE_WORDS = /^(bill|invoice|inv|charge|purchase|po|receipt|statement\s*charge)\b/;

// A header cell that is only noise -- QuickBooks pads its exports with
// blank and unnamed columns.
const isNoise = (c) => !c || /^(unnamed|column\s*\d+|_+)$/i.test(c);

function rowsFrom(text) {
  const raw = String(text == null ? '' : text)
    .replace(/^﻿/, '')
    .split(/\r\n|\n|\r/);

  // Tabs or commas: whichever the body of the file actually uses. Counted
  // over the file rather than the first line, because QuickBooks puts a
  // title line at the top that may contain neither.
  const body = raw.join('\n');
  const tabs = (body.match(/\t/g) || []).length;
  const commas = (body.match(/,/g) || []).length;
  const split = tabs > commas ? splitTabLine : splitLine;

  const out = [];
  raw.forEach((line, i) => {
    // The source row number, as the spreadsheet counts them, so that
    // "row 14" means row 14 when he opens the file to look.
    if (!line || !line.replace(/[\s,\t]/g, '')) return;
    out.push({ n: i + 1, cells: split(line) });
  });
  return out;
}

// Finds the header row and works out which column is which.
//
// It needs a date column and an amount column to call a row the header;
// everything else is optional, because the three shapes above disagree
// about what else they carry.
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].cells;
    const low = cells.map((c) => String(c || '').toLowerCase().trim());

    const hasDate = low.some((c) => /^(date|txn date|transaction date|posted)/.test(c));
    const hasMoney = low.some((c) => /amount|amt|total|debit|credit|balance/.test(c));
    if (!hasDate || !hasMoney) continue;

    const idx = { date: -1, due: -1, type: -1, number: -1, vendor: -1,
                  memo: -1, amount: -1, open: -1, paid: -1 };

    low.forEach((c, j) => {
      if (isNoise(c)) return;

      // Order matters. "Due Date" must not be taken for the date, and
      // "Open Balance" must not be taken for the amount -- read either way
      // round and every line lands with the wrong figure on it.
      if (idx.due < 0 && /due\s*date|date\s*due/.test(c)) { idx.due = j; return; }
      if (idx.open < 0 && /open\s*(balance|bal)|balance\s*(due|remaining)|remaining/.test(c)) {
        idx.open = j; return;
      }
      if (idx.paid < 0 && /^(paid|is\s*paid|settled|cleared|status)\b/.test(c)) {
        idx.paid = j; return;
      }
      if (idx.date < 0 && /^(date|txn date|transaction date|posted|post date)/.test(c)) {
        idx.date = j; return;
      }
      if (idx.type < 0 && /^(type|txn type|transaction type|trans type|kind)\b/.test(c)) {
        idx.type = j; return;
      }
      if (idx.number < 0 && /^(num|no\.?|number|#|doc|ref|invoice\s*(number|num|no\.?|#)?|bill\s*(number|num|no\.?|#)?|check\s*(number|num|no\.?|#)?)\b/.test(c)) {
        idx.number = j; return;
      }
      if (idx.vendor < 0 && /^(name|vendor|payee|supplier|company)\b/.test(c)) {
        idx.vendor = j; return;
      }
      if (idx.memo < 0 && /^(memo|description|desc|detail|note|comment)\b/.test(c)) {
        idx.memo = j; return;
      }
      if (idx.amount < 0 && /^(amount|amt|total|charge|debit)\b/.test(c)) {
        idx.amount = j; return;
      }
    });

    if (idx.date > -1 && idx.amount > -1) {
      return { row: i, idx: idx, columns: cells };
    }
    // A sheet whose only money column is "Open Balance" -- an aging report
    // with nothing else on it. The open balance is then the amount.
    if (idx.date > -1 && idx.open > -1) {
      idx.amount = idx.open;
      return { row: i, idx: idx, columns: cells, amount_is_open_balance: true };
    }
  }
  return null;
}

// A total row rather than a transaction. QuickBooks puts these in the middle
// of its exports, per vendor, and importing them would double everything.
function looksLikeATotal(cells, idx) {
  const joined = cells.join(' ').toLowerCase();
  if (/^\s*(total|subtotal|grand total|sum)\b/.test(joined)) return true;
  // "Total Sysco" -- a vendor's subtotal, dated nowhere.
  if (/\btotal\b/.test(joined) && !toDate(cells[idx.date])) return true;
  return false;
}

/**
 * Reads a sheet into lines ready to be entered.
 *
 * Returns { ok, shape, columns, header_row, lines, unreadable, skipped,
 *           has_open_balance, has_paid_column }
 *
 * Each line: { row, kind, date, number, amount, due_date, memo,
 *              vendor_name, already_paid, open_balance }
 *
 * kind is 'invoice' or 'payment'. already_paid is true only when the sheet
 * SAYS so -- an Open Balance of zero, or a Paid column that says yes. It is
 * never inferred from the amount.
 */
function readVendorSheet(text) {
  const rows = rowsFrom(text);
  if (!rows.length) {
    return { ok: false, error: 'That sheet is empty.', lines: [], unreadable: [], skipped: [] };
  }

  const head = findHeader(rows);
  if (!head) {
    return {
      ok: false,
      error: 'Could not find the column headings. The sheet needs a row with ' +
             'a Date heading and an Amount heading on it.',
      first_rows: rows.slice(0, 5).map((r) => r.cells),
      lines: [], unreadable: [], skipped: [],
    };
  }

  const idx = head.idx;
  const lines = [];
  const unreadable = [];
  const skipped = [];

  for (let i = head.row + 1; i < rows.length; i++) {
    const row = rows[i];
    const cells = row.cells;
    const cell = (j) => (j > -1 && j < cells.length ? String(cells[j] || '').trim() : '');

    if (looksLikeATotal(cells, idx)) {
      skipped.push({ row: row.n, why: 'a total line', text: cells.join(' ').trim().slice(0, 80) });
      continue;
    }

    const date = toDate(cell(idx.date));
    const amountRaw = toAmount(cell(idx.amount));

    if (!date && isNaN(amountRaw)) {
      // Neither a date nor a number: almost certainly a spacer or a
      // repeated heading, not a line he meant to import.
      skipped.push({ row: row.n, why: 'no date and no amount', text: cells.join(' ').trim().slice(0, 80) });
      continue;
    }
    if (!date) {
      unreadable.push({ row: row.n, why: 'could not read the date', cells: cells.slice(0, 8) });
      continue;
    }
    if (isNaN(amountRaw)) {
      unreadable.push({ row: row.n, why: 'could not read the amount', cells: cells.slice(0, 8) });
      continue;
    }
    if (amountRaw === 0) {
      skipped.push({ row: row.n, why: 'zero amount', text: cells.join(' ').trim().slice(0, 80) });
      continue;
    }

    // What kind of line this is. The Type column decides when there is one.
    // With no Type column everything is a bill, because a vendor statement
    // without a type column is a list of bills -- and a sheet that turns
    // out to hold payments too will show that in the preview before
    // anything is written.
    const typeWord = cell(idx.type).toLowerCase();
    let kind = 'invoice';
    if (typeWord) {
      if (PAYMENT_WORDS.test(typeWord)) kind = 'payment';
      else if (INVOICE_WORDS.test(typeWord)) kind = 'invoice';
      else if (amountRaw < 0) kind = 'payment';
    } else if (amountRaw < 0) {
      // No word to go on. A negative on a vendor sheet is a payment or a
      // credit; either way it is money coming off what he owes.
      kind = 'payment';
    }

    const openCell = cell(idx.open);
    const openBalance = openCell ? toAmount(openCell) : NaN;
    const paidCell = cell(idx.paid).toLowerCase();

    let alreadyPaid = false;
    if (paidCell) {
      if (/^(y|yes|true|paid|1|cleared|settled|closed)\b/.test(paidCell)) alreadyPaid = true;
    } else if (idx.open > -1 && !head.amount_is_open_balance && !isNaN(openBalance)) {
      // An aging report carries what is left on each bill. Nothing left
      // means it has been paid -- and that is the sheet saying so, not us
      // working it out.
      alreadyPaid = money(openBalance) === 0;
    }

    lines.push({
      row: row.n,
      kind: kind,
      date: date,
      number: cell(idx.number) || null,
      // The sign has done its job in picking the kind; the amount itself is
      // what it is worth, and the kind says which way it goes.
      amount: money(Math.abs(amountRaw)),
      due_date: toDate(cell(idx.due)) || null,
      memo: cell(idx.memo) || null,
      vendor_name: cell(idx.vendor) || null,
      already_paid: alreadyPaid,
      open_balance: isNaN(openBalance) ? null : money(openBalance),
    });
  }

  const invoices = lines.filter((l) => l.kind === 'invoice');
  const payments = lines.filter((l) => l.kind === 'payment');

  return {
    ok: true,
    shape: head.amount_is_open_balance ? 'aging report'
         : idx.type > -1 ? 'transaction list'
         : 'statement',
    columns: head.columns.filter((c) => !isNoise(c)),
    header_row: rows[head.row].n,
    mapped: idx,
    has_open_balance: idx.open > -1,
    has_paid_column: idx.paid > -1,
    lines: lines,
    unreadable: unreadable,
    skipped: skipped,
    summary: {
      invoices: invoices.length,
      invoices_total: money(invoices.reduce((s, l) => s + l.amount, 0)),
      payments: payments.length,
      payments_total: money(payments.reduce((s, l) => s + l.amount, 0)),
      already_paid: lines.filter((l) => l.already_paid).length,
      unreadable: unreadable.length,
      skipped: skipped.length,
    },
  };
}

module.exports = { readVendorSheet, looksLikeATotal, money };

// Deciding whether a photographed check can be trusted.
//
// ---------------------------------------------------------------------
// Why the comparison happens here and not in the prompt
//
// A check states its amount twice: the numeric box, and the words on the
// long line. That is the whole reason a photographed check is safer to
// trust than a photographed invoice -- the paper carries its own second
// opinion.
//
// The obvious way to use that is to ask the model "do these two agree?"
// It is also the useless way. If the model misreads one of them it will
// cheerfully report that they agree, and the one check that was supposed
// to catch a misreading has been handed to the thing doing the
// misreading. The failure is silent and looks exactly like success.
//
// So the model is asked for both amounts, separately, and told not to
// make them agree. The comparison is arithmetic, done here, where a
// disagreement can be shown with both numbers on screen.
//
// ---------------------------------------------------------------------
// A stub has no second opinion
//
// A carbon copy or register page carries one figure in Raz's
// handwriting. Nothing to compare it against. That does not make it
// useless -- it makes it a draft that a person has to confirm, and the
// result says which kind of paper it came from so the screen can say so
// too.

const { amountInWords } = require('./checkwords');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Written amounts come off a photograph with inconsistent spacing, case
// and punctuation. Compared on letters and digits only.
const squash = (s) => String(s || '')
  .toUpperCase()
  .replace(/AND\s+(\d\d)\s*\/\s*100/, 'AND$1/100')
  .replace(/[^A-Z0-9/]/g, '');

/**
 * Does the written line say the same thing as the figure?
 *
 * Checked by writing the figure out ourselves -- with the same code that
 * prints checks -- and comparing. That is stricter than parsing the
 * words back into a number, and it fails safe: anything we cannot write
 * is something we will not vouch for.
 */
function wordsMatchFigure(written, figure) {
  if (written === null || written === undefined || written === '') return null;
  if (figure === null || figure === undefined) return null;
  const ours = amountInWords(figure);
  if (ours === null) return false;
  return squash(ours) === squash(written);
}

/**
 * What to do with what came back from the photograph.
 *
 * Returns { trust, amount, why, needs_eyes } where trust is:
 *
 *   'verified'  the check said the amount twice and both agree
 *   'single'    only one amount was legible -- a stub, usually
 *   'conflict'  the two amounts disagree. Nothing is filled in.
 */
function judge(draft) {
  const numeric = draft.amount_numeric === null || draft.amount_numeric === undefined
    ? null : money(draft.amount_numeric);
  const written = draft.amount_written || null;
  const why = [];

  if (numeric === null && !written) {
    return {
      trust: 'conflict',
      amount: null,
      why: ['No amount could be read from the photo.'],
      needs_eyes: true,
    };
  }

  const agree = wordsMatchFigure(written, numeric);

  if (agree === false) {
    // The important one. Both were read, and they do not say the same
    // thing -- so either the photo was misread or the check itself is
    // inconsistent. Either way nothing is filled in and both figures go
    // on screen for a person to look at.
    return {
      trust: 'conflict',
      amount: null,
      numeric: numeric,
      written: written,
      why: ['The box says ' + (numeric === null ? 'nothing readable' : numeric.toFixed(2))
        + ' and the written line says "' + written + '". They do not agree, so '
        + 'nothing has been filled in.'],
      needs_eyes: true,
    };
  }

  if (agree === true) {
    // Both read, both agree. The strongest evidence available from a
    // piece of paper.
    if (draft.handwritten) {
      why.push('Handwritten, but the written line and the box agree.');
    }
    return {
      trust: 'verified',
      amount: numeric,
      numeric: numeric,
      written: written,
      why: why,
      needs_eyes: false,
    };
  }

  // Only one of the two was legible. Usually a stub.
  const single = numeric !== null ? numeric : null;
  why.push(draft.is_stub
    ? 'This is a stub, so there is only one amount on it and nothing to check it against.'
    : 'Only one of the two amounts could be read, so there is nothing to check it against.');
  if (draft.handwritten) why.push('The amount is handwritten.');

  return {
    trust: 'single',
    amount: single,
    numeric: numeric,
    written: written,
    why: why,
    needs_eyes: true,
  };
}

module.exports = { judge, wordsMatchFigure, squash };

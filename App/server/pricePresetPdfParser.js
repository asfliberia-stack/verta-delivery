// Price Presets PDF import — text-to-rows parsing.
//
// Split deliberately into two stages, only one of which lives here:
//   1. PDF bytes -> raw text (server.js, using the `pdf-parse` package).
//      Can't be exercised in this sandbox — see README for why (same
//      CDN/registry block that's affected every other PDF-handling
//      feature built this session).
//   2. Raw text -> { label, amount } rows (this file). Plain string/
//      regex logic with zero external dependencies, so — unlike stage
//      1 — it's fully unit-testable without pdf-parse installed at all.
//
// This is a heuristic, not a real table parser: it has no idea what
// the source PDF's actual layout looks like (no sample was provided
// when this was built), so it looks for the common shape of a price
// list — "<label> ... <amount>" per line, optionally with a $ sign,
// dots/dashes as a leader, or a colon — and skips anything that
// doesn't look like that. It is expected to occasionally produce a
// wrong or nonsense row (e.g. from a page-number footer); that's why
// the import flow built on top of this always shows a preview the
// Super Admin can edit/remove rows from before anything is actually
// saved, rather than importing directly.

const MAX_LABEL_LENGTH = 200;
const MAX_AMOUNT = 100000; // sanity cap — a delivery fee preset over $100,000 is almost certainly a mis-parse
const MAX_ROWS = 200; // matches the caps used elsewhere in this app for bulk/list imports (e.g. FAQ editor)

// Lines that are noise in almost any real-world PDF export, regardless
// of the actual price-list content — page footers/headers, table
// headers with no real label, and section dividers.
const NOISE_LINE_PATTERNS = [
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /^\d+\s*\/\s*\d+$/, // "1/3" style page markers
  /^(label|amount|price|fee|rate|item|description|qty|quantity)$/i,
  /^[-=_*.\s]+$/, // divider lines like "----" or "...."
];

// A line qualifies as a candidate price row if, after trimming any
// leader characters (dots/dashes used to visually connect a label to
// its price, e.g. "Standard Delivery ......... $5.00"), it ends in a
// number that looks like a currency amount.
const ROW_PATTERN = /^(.+?)[\s.\-:|_]*\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)\s*$/;

function cleanLabel(raw) {
  return raw
    .replace(/[\s.\-:|_]+$/, '') // trailing leader characters left over from the split
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses raw extracted PDF text into candidate price preset rows.
 * @param {string} text - raw text extracted from the PDF (e.g. via pdf-parse's `.text`)
 * @returns {{ rows: {label: string, amount: number}[], skippedLines: number, truncated: boolean }}
 */
function parsePriceRowsFromText(text) {
  if (!text || typeof text !== 'string') {
    return { rows: [], skippedLines: 0, truncated: false };
  }
  const lines = text.split(/\r?\n/);
  const rows = [];
  let skippedLines = 0;
  let truncated = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (NOISE_LINE_PATTERNS.some(p => p.test(line))) continue;

    const match = ROW_PATTERN.exec(line);
    if (!match) {
      skippedLines += 1;
      continue;
    }

    const label = cleanLabel(match[1]);
    const amount = Number(match[2].replace(/,/g, ''));

    // A label must contain at least one real letter — filters out
    // lines that are really just two numbers (e.g. a date, or a page
    // range) rather than an actual "name -> price" row.
    if (!label || !/[A-Za-z]/.test(label) || label.length > MAX_LABEL_LENGTH) {
      skippedLines += 1;
      continue;
    }
    if (!Number.isFinite(amount) || amount < 0 || amount > MAX_AMOUNT) {
      skippedLines += 1;
      continue;
    }

    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    rows.push({ label, amount: Math.round(amount * 100) / 100 });
  }

  return { rows, skippedLines, truncated };
}

module.exports = { parsePriceRowsFromText, MAX_LABEL_LENGTH, MAX_AMOUNT, MAX_ROWS };

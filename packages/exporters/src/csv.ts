/**
 * Deterministic RFC-4180 CSV serialization. Fixed column order, `\n` line
 * endings, a trailing newline, and quote-on-need escaping so output is
 * byte-stable for golden tests. Numbers are only permitted when integral
 * (counts); money must arrive as a decimal string — a float here is a bug
 * (ADR-004), so a non-integer number throws rather than serializing silently.
 *
 * Callers pass already-sorted, already-sanitized rows (C6, ADR-011): no `*_raw`
 * hostile string ever reaches a cell.
 *
 * Formula injection (CWE-1236): a spreadsheet evaluates a cell whose text begins
 * with `= + - @` (or tab/CR) as a formula, and CSV quoting does NOT neutralize
 * that. A minted token symbol like `+SUM(..)` survives the core sanitizer (its
 * allowlist keeps `+`/`-`), so we neutralize at the serialization boundary with a
 * leading apostrophe — but never on a real numeric literal, since money decimal
 * strings (`-6000.00`) and log_index sentinels (`-1`/`-2`/`-3`) legitimately lead
 * with `-`.
 */
export type CsvValue = string | number;

const FORMULA_LEAD = /^[=+\-@\t\r\n]/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

function escapeField(v: CsvValue): string {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      throw new Error(
        `csv: refusing to serialize non-integer number ${String(v)}; money must be a decimal string (ADR-004)`,
      );
    }
    s = String(v);
  } else {
    s = v;
  }
  // Formula-injection guard (defense-in-depth; do not rely on the upstream
  // sanitizer's allowlist). Numeric literals are exempt so signed amounts and
  // log_index sentinels pass through unchanged.
  if (s.length > 0 && FORMULA_LEAD.test(s) && !NUMERIC.test(s)) {
    s = `'${s}`;
  }
  // Quote when the field contains a delimiter/quote/newline, or has edge whitespace
  // a naive parser would trim. Internal quotes are doubled.
  if (/[",\r\n]/.test(s) || s !== s.trim()) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  const lines = [header.map(escapeField).join(',')];
  for (const row of rows) lines.push(row.map(escapeField).join(','));
  return `${lines.join('\n')}\n`;
}

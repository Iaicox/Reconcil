/**
 * Deterministic RFC-4180 CSV serialization. Fixed column order, `\n` line
 * endings, a trailing newline, and quote-on-need escaping so output is
 * byte-stable for golden tests. Numbers are only permitted when integral
 * (counts); money must arrive as a decimal string — a float here is a bug
 * (ADR-004), so a non-integer number throws rather than serializing silently.
 *
 * Callers pass already-sorted, already-sanitized rows (C6, ADR-011): no `*_raw`
 * hostile string ever reaches a cell.
 */
export type CsvValue = string | number;

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

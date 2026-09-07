/**
 * Deterministic, filename-safe period spelling shared by every export renderer
 * (journal drafts, close-pack CSVs). A pure function of `period.start`/`period.end`
 * only — no clock, no fs (this package stays a pure render layer). The same period
 * always yields the same slug (byte-stability for exported filenames); two distinct
 * periods always yield distinct slugs.
 *
 * Scheme: a period that spans exactly one calendar month (`start` is that month's
 * 1st, `end` is that month's last day) collapses to the short form `YYYY-MM`; every
 * other period spells out both ends as `<start>_<end>`. This is the ONE scheme used
 * everywhere a rendered file needs a period in its name.
 */
import type { ExportPeriod } from './types.js';

/**
 * True when `period` is exactly one calendar month. `Date.UTC(year, month, 0)` is
 * pure calendar arithmetic on the given `year`/`month` — passing the 1-based target
 * month lands on day 0 of the (0-based) next month, i.e. the last day of the target
 * month. It never reads the system clock.
 */
function isCalendarMonth(period: ExportPeriod): boolean {
  const m = /^(\d{4})-(\d{2})-01$/.exec(period.start);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-based
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return period.end === `${m[1]}-${m[2]}-${String(lastDay).padStart(2, '0')}`;
}

export function periodSlug(period: ExportPeriod): string {
  if (isCalendarMonth(period)) return period.start.slice(0, 7); // 'YYYY-MM-01' -> 'YYYY-MM'
  return `${period.start}_${period.end}`;
}

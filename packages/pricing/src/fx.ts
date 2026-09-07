/**
 * ECB FX resolution: for a target date, the latest reference rate whose
 * `rate_date` ≤ that date (weekend/holiday rule, ADR-007). A shifted date sets
 * `shifted` so the caller can emit FX_DATE_SHIFTED — the used date is visible in
 * citations, never silently substituted. ECB publishes EUR-based rates.
 */
import { fxRates, type Db, type Tx } from '@reconcil/db';
import { and, eq, lte } from 'drizzle-orm';

import type { FxResolved, FxRow } from './types.js';

/**
 * Same-date source rank (lower wins): `manual` first — a manual row exists
 * specifically to override the automated feed — then `ecb`; anything else ranks
 * after `ecb` (H4).
 */
function sourceRank(source: string): number {
  if (source === 'manual') return 0;
  if (source === 'ecb') return 1;
  return 2;
}

/**
 * Total order over same-date rows: source rank, then (for two unranked/"other"
 * sources) alphabetical by source name, then highest `id` as the final tiebreak.
 * Returns true when `a` should win over `b`. Deterministic and independent of
 * scan order — required because `fx_rates`' unique key is
 * `(rate_date, base, quote, source)`, so a `manual` correction and the `ecb` row
 * can legitimately coexist for the same date.
 */
function isBetterSameDate(a: FxRow, b: FxRow): boolean {
  const ra = sourceRank(a.source);
  const rb = sourceRank(b.source);
  if (ra !== rb) return ra < rb;
  if (ra === 2 && a.source !== b.source) return a.source < b.source;
  return a.id > b.id;
}

/**
 * Latest rate ≤ `date` (order-independent — a strict total order, so the result
 * never depends on row scan order). Same-date ties break via `isBetterSameDate`:
 * `manual` beats `ecb` beats anything else (unknown sources tied alphabetically),
 * then highest `id` — so two runs of the same tool call always pin the same
 * `fx_rate_id` (P5/C4, H4). Shifted when the picked row isn't the exact date.
 */
export function pickLatestRate(rows: FxRow[], date: string): FxResolved | undefined {
  let best: FxRow | undefined;
  for (const r of rows) {
    if (r.rateDate > date) continue;
    if (best === undefined || r.rateDate > best.rateDate) { best = r; continue; }
    if (r.rateDate === best.rateDate && isBetterSameDate(r, best)) best = r;
  }
  return best === undefined ? undefined : { row: best, shifted: best.rateDate !== date };
}

export async function resolveFxRates(
  db: Db | Tx,
  dates: string[],
  opts: { base: string; quote: string },
): Promise<Map<string, FxResolved>> {
  const out = new Map<string, FxResolved>();
  const uniq = [...new Set(dates)];
  if (uniq.length === 0) return out;
  const maxDate = uniq.reduce((a, b) => (a > b ? a : b));

  const rows = await db
    .select({
      id: fxRates.id, rateDate: fxRates.rateDate, baseCurrency: fxRates.baseCurrency,
      quoteCurrency: fxRates.quoteCurrency, rate: fxRates.rate, source: fxRates.source,
    })
    .from(fxRates)
    .where(and(eq(fxRates.baseCurrency, opts.base), eq(fxRates.quoteCurrency, opts.quote), lte(fxRates.rateDate, maxDate)));

  for (const d of uniq) {
    const picked = pickLatestRate(rows, d);
    if (picked) out.set(d, picked);
  }
  return out;
}

/**
 * ECB FX resolution: for a target date, the latest reference rate whose
 * `rate_date` ≤ that date (weekend/holiday rule, ADR-007). A shifted date sets
 * `shifted` so the caller can emit FX_DATE_SHIFTED — the used date is visible in
 * citations, never silently substituted. ECB publishes EUR-based rates.
 */
import { fxRates, type Db } from '@pet-crypto/db';
import { and, eq, lte } from 'drizzle-orm';

import type { FxResolved, FxRow } from './types.js';

/** Latest rate ≤ `date` (order-independent); shifted when it isn't the exact date. */
export function pickLatestRate(rows: FxRow[], date: string): FxResolved | undefined {
  let best: FxRow | undefined;
  for (const r of rows) {
    if (r.rateDate <= date && (best === undefined || r.rateDate > best.rateDate)) best = r;
  }
  return best === undefined ? undefined : { row: best, shifted: best.rateDate !== date };
}

export async function resolveFxRates(
  db: Db,
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

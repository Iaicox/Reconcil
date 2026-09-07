/**
 * DRY the pricing→wire plumbing every valued analytics_* tool repeats: build the
 * pricing `Valuation` without an undefined `policy` key, map pricing's camelCase
 * `PriceRef`/`FxRef` to the wire snake_case (contract §2), and normalize
 * `PricingWarning` into the envelope `Warning`. Shared by balances/flows/gas/
 * stablecoin so a citation-mapping change lands in one place (C4/C5).
 *
 * Also the shared `price_snapshots`/`fx_rates` → wire `PriceRef`/`FxRef` hydration (H11):
 * decision-repo re-hydrates a single leg's pinned refs for the confirm/reject envelope;
 * export-journal-drafts batches the distinct pinned ids across a whole period's confirmed
 * legs. Both read the exact same columns, so the SQL lives here once.
 */
import { fxRates, priceSnapshots, tokens, type Db, type Tx } from '@reconcil/db';
import { eq, inArray } from 'drizzle-orm';

import type { FxRef, PriceRef, Warning } from '@reconcil/core';
import type {
  FxRef as PricingFxRef, PriceRef as PricingPriceRef, Valuation, ValuationResult,
} from '@reconcil/pricing';

/** Map pricing's camelCase `PriceRef` to the wire snake_case shape (contract §2, C4). */
export function toWirePriceRef(p: PricingPriceRef): PriceRef {
  return { snapshot_id: p.snapshotId, token: p.token, date: p.date, currency: p.currency, source: p.source, price: p.price };
}

/** Map pricing's camelCase `FxRef` to the wire snake_case shape (contract §2, C4). */
export function toWireFxRef(f: PricingFxRef): FxRef {
  return { fx_rate_id: f.fxRateId, date: f.date, base: f.base, quote: f.quote, rate: f.rate, source: f.source };
}

/**
 * A pricing `Valuation` with no `undefined` policy key — the Zod-inferred input
 * carries `policy?: … | undefined` (exactOptionalPropertyTypes), which pricing's
 * strict `Valuation` interface rejects; drop the key when absent.
 */
export function toWireValuation(v: { currency: 'USD' | 'EUR'; policy?: 'market' | 'peg_for_stables' | undefined }): Valuation {
  return v.policy !== undefined ? { currency: v.currency, policy: v.policy } : { currency: v.currency };
}

/** Map a valuation result's refs + warnings to the wire envelope shapes (C4/C5). */
export function collectPricingRefs(valued: ValuationResult): { priceRefs: PriceRef[]; fxRefs: FxRef[]; warnings: Warning[] } {
  return {
    priceRefs: valued.priceRefs.map(toWirePriceRef),
    fxRefs: valued.fxRefs.map(toWireFxRef),
    warnings: valued.warnings.map((w) => ({ code: w.code, message: w.message, ...(w.context ? { context: w.context } : {}) })),
  };
}

/**
 * Re-hydrate `price_snapshots` rows pinned by id into wire `PriceRef`s, keyed by
 * `snapshot_id` (H11, C4 "priced means pinned"). `ids` is de-duplicated by the caller;
 * an empty list short-circuits (no query) — the common stablecoin-face-value path.
 */
export async function hydratePriceRefs(db: Db | Tx, ids: number[]): Promise<Map<number, PriceRef>> {
  const map = new Map<number, PriceRef>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      id: priceSnapshots.id, tokenId: priceSnapshots.tokenId, priceDate: priceSnapshots.priceDate,
      currency: priceSnapshots.currency, price: priceSnapshots.price, source: priceSnapshots.source,
      symbol: tokens.symbolDisplay,
    })
    .from(priceSnapshots)
    .innerJoin(tokens, eq(tokens.id, priceSnapshots.tokenId))
    .where(inArray(priceSnapshots.id, ids));
  for (const r of rows) {
    map.set(r.id, {
      snapshot_id: r.id, token: r.symbol ?? String(r.tokenId), date: r.priceDate,
      currency: r.currency, source: r.source, price: r.price,
    });
  }
  return map;
}

/** Re-hydrate `fx_rates` rows pinned by id into wire `FxRef`s, keyed by `fx_rate_id` (H11). */
export async function hydrateFxRefs(db: Db | Tx, ids: number[]): Promise<Map<number, FxRef>> {
  const map = new Map<number, FxRef>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      id: fxRates.id, rateDate: fxRates.rateDate, base: fxRates.baseCurrency,
      quote: fxRates.quoteCurrency, rate: fxRates.rate, source: fxRates.source,
    })
    .from(fxRates)
    .where(inArray(fxRates.id, ids));
  for (const r of rows) {
    map.set(r.id, { fx_rate_id: r.id, date: r.rateDate, base: r.base, quote: r.quote, rate: r.rate, source: r.source });
  }
  return map;
}

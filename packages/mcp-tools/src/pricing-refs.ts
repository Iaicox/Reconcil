/**
 * DRY the pricing→wire plumbing every valued analytics_* tool repeats: build the
 * pricing `Valuation` without an undefined `policy` key, map pricing's camelCase
 * `PriceRef`/`FxRef` to the wire snake_case (contract §2), and normalize
 * `PricingWarning` into the envelope `Warning`. Shared by balances/flows/gas/
 * stablecoin so a citation-mapping change lands in one place (C4/C5).
 */
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

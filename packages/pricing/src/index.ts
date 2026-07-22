/**
 * Pricing: daily UTC price snapshots and ECB FX; valuation always references a
 * pinned snapshot ID — audit reproducibility (ADR-007, P5). Public surface: the
 * deterministic `valueQuantities` (mcp-tools composes it over ledger rows).
 */
// Valuation read-core (mcp-tools composes this over ledger rows).
export { valueQuantities, valueOne, type ValuedOne } from './value.js';
export { resolvePrices, pickSnapshot, priceKey } from './resolve.js';
export { resolveFxRates, pickLatestRate } from './fx.js';
export { multiply, divide, roundHalfUp, sumDecimals, numberToDecimalString } from './decimal.js';
export type {
  Currency, ValuationPolicy, Valuation, ValueNeed, ValuedNeed, SnapshotRow, FxRow,
  FxResolved, PriceRef, FxRef, PricingWarning, PricingWarningCode, ValuationResult,
} from './types.js';

// Fetch write-side (worker prices job composes this).
export {
  upsertSnapshots, upsertFxRates, materializePegSnapshots,
  type SnapshotInsert, type FxInsert,
} from './snapshot-service.js';
export { priceGaps, fxDateRange, type PriceGap } from './gaps.js';
export { runPriceFill, type FillDeps, type FillResult } from './fill.js';
export { buildPriceProviderBundle, firstPrice } from './providers/provider-factory.js';
export {
  realFetchJson, throttled, fixtureTransport, recordingTransport, canonicalizeUrl, fixtureFileName,
  type FetchJson,
} from './providers/transport.js';
export type { PriceBundle, PriceProvider, FxProvider, PriceQuery, DailyPrice, FxRatePoint } from './providers/types.js';
export { CHAIN_SLUG } from './providers/types.js';

/**
 * Pricing domain types. Fiat values cross the surface as `DecimalString`
 * (ADR-004). Valuation always references a pinned snapshot/FX row so any figure
 * is reproducible and citable (ADR-007, P5, invariant C4). Pricing is
 * tenant-agnostic: it values quantities handed to it, resolution lives above.
 */
import type { DecimalString } from '@pet-crypto/core';

export type Currency = 'USD' | 'EUR';
export type ValuationPolicy = 'market' | 'peg_for_stables';

/** The opt-in valuation request (contracts §2 `Valuation`). */
export interface Valuation {
  currency: Currency;
  policy?: ValuationPolicy; // default resolved above (tenant setting); pricing treats undefined as 'market'
}

/** One quantity to value: scaled display units of a token on a UTC date. */
export interface ValueNeed {
  tokenId: number;
  date: string; // ISO UTC date 'YYYY-MM-DD'
  amount: DecimalString; // scaled display units (from ledger)
  isStablecoin: boolean;
  pegCurrency: string | null;
  symbol?: string | null; // label for the citation ref
}

/** Per-need result; `fiatValue` omitted (never guessed) on PRICE_MISSING (C4). */
export interface ValuedNeed {
  tokenId: number;
  date: string;
  fiatValue?: DecimalString;
}

/** Subset of a `price_snapshots` row the valuation math reads. */
export interface SnapshotRow {
  id: number;
  tokenId: number;
  priceDate: string;
  currency: string;
  price: string; // per 1 whole token, display units
  source: string; // 'defillama' | 'coingecko' | 'peg' | 'manual'
}

/** Subset of an `fx_rates` row (ECB EUR-based). */
export interface FxRow {
  id: number;
  rateDate: string;
  baseCurrency: string; // 'EUR'
  quoteCurrency: string; // 'USD'
  rate: string; // quote per 1 base (USD per 1 EUR)
  source: string;
}

/** Resolved FX for a target date: the row + whether its date was shifted back. */
export interface FxResolved {
  row: FxRow;
  shifted: boolean; // ECB rate date < target date → FX_DATE_SHIFTED
}

/** Citation refs (contracts §2). snake_case mapping to the wire happens in mcp-tools. */
export interface PriceRef {
  snapshotId: number;
  token: string;
  date: string;
  currency: string;
  source: string;
  price: DecimalString;
}
export interface FxRef {
  fxRateId: number;
  date: string;
  base: string;
  quote: string;
  rate: DecimalString;
  source: string;
}

export type PricingWarningCode = 'PRICE_MISSING' | 'FX_DATE_SHIFTED';
export interface PricingWarning {
  code: PricingWarningCode;
  message: string;
  context?: Record<string, unknown>;
}

export interface ValuationResult {
  currency: Currency;
  values: ValuedNeed[];
  priceRefs: PriceRef[];
  fxRefs: FxRef[];
  warnings: PricingWarning[];
}

/**
 * Price/FX provider contracts (ADR-007, ADR-009 shape). Adapters are dumb: they
 * fetch and parse into one canonical figure per UTC date; retries/throttling/failover live
 * above (worker + factory). Prices are quoted in USD; ECB FX is EUR-based.
 */
import type { FetchJson } from './transport.js';

export type { FetchJson };

/** A token's figure for one UTC date as returned by a source, in `currency`. Not a close:
 *  DefiLlama is asked for a literal 00:00 UTC timestamp and CoinGecko for a bare date, which
 *  requests no instant at all (ADR-007 d1, amended 2026-09-15). This type deliberately carries
 *  no timestamp — see 09-known-gaps.md on the missing provenance. */
export interface DailyPrice {
  price: string; // canonical decimal string
  currency: string; // 'USD'
}

/** What a source needs to look up one token's figure for a UTC date. */
export interface PriceQuery {
  chainSlug: string; // DefiLlama chain slug: 'ethereum' | 'base'
  address: string | null; // erc20 contract (lowercase); null = native
  coingeckoId: string | null;
  date: string; // UTC 'YYYY-MM-DD'
}

export interface PriceProvider {
  readonly source: string; // 'defillama' | 'coingecko'
  dailyPrice(q: PriceQuery): Promise<DailyPrice | null>;
}

/** One ECB EUR-based reference rate: `rate` = `quote` per 1 EUR on `date`. */
export interface FxRatePoint {
  date: string; // UTC 'YYYY-MM-DD'
  quote: string; // 'USD'
  rate: string; // canonical decimal string
}

/** ECB FX source — fetched over a date range (ECB has no weekend/holiday rows). */
export interface FxProvider {
  readonly source: string; // 'ecb'
  rangeRates(from: string, to: string): Promise<FxRatePoint[]>;
}

export interface PriceBundle {
  price: PriceProvider[]; // tried in order (DefiLlama → CoinGecko)
  fx: FxProvider;
}

/** DefiLlama chain slugs by chain id (extend as chains are enabled). */
export const CHAIN_SLUG: Record<number, string> = { 1: 'ethereum', 8453: 'base' };

/**
 * Assemble the price/FX sources for a run (ADR-007/009). DefiLlama is primary,
 * CoinGecko secondary; `firstPrice` implements the failover (first non-null
 * wins, tagged with its source so the snapshot records provenance).
 */
import { coinGeckoProvider } from './coingecko.js';
import { defiLlamaProvider } from './defillama.js';
import { ecbProvider } from './ecb.js';
import type { DailyPrice, FetchJson, PriceBundle, PriceProvider, PriceQuery } from './types.js';

export function buildPriceProviderBundle(opts: {
  env: Record<string, string | undefined>;
  fetchJson: FetchJson;
}): PriceBundle {
  return {
    price: [defiLlamaProvider(opts.fetchJson), coinGeckoProvider(opts.fetchJson, opts.env.COINGECKO_API_KEY)],
    fx: ecbProvider(opts.fetchJson),
  };
}

/** Try sources in order; the first non-null close wins, tagged with its source. */
export async function firstPrice(
  providers: PriceProvider[],
  q: PriceQuery,
): Promise<{ price: DailyPrice; source: string } | null> {
  for (const p of providers) {
    const price = await p.dailyPrice(q);
    if (price !== null) return { price, source: p.source };
  }
  return null;
}

/**
 * DefiLlama — primary price source (ADR-007). Keyed by `{chain}:{address}` for
 * erc20 (no ID-mapping table needed) and `coingecko:{id}` for a chain's native
 * token. Historical endpoint returns the close nearest a timestamp within
 * `searchWidth`; a missing coin key ⇒ null (caller falls back / PRICE_MISSING).
 */
import { numberToDecimalString } from '../decimal.js';
import type { DailyPrice, FetchJson, PriceProvider, PriceQuery } from './types.js';

/** Unix seconds for 00:00:00 UTC of a `YYYY-MM-DD` date. */
function dayTs(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

export function defiLlamaCoinKey(q: PriceQuery): string | null {
  if (q.address) return `${q.chainSlug}:${q.address.toLowerCase()}`;
  if (q.coingeckoId) return `coingecko:${q.coingeckoId}`; // native → coingecko id
  return null;
}

export function parseDefiLlama(body: unknown, coinKey: string): DailyPrice | null {
  const coins = (body as { coins?: Record<string, { price?: unknown }> }).coins;
  const price = numberToDecimalString(coins?.[coinKey]?.price);
  return price === null ? null : { price, currency: 'USD' };
}

export function defiLlamaProvider(fetchJson: FetchJson): PriceProvider {
  return {
    source: 'defillama',
    async dailyPrice(q) {
      const key = defiLlamaCoinKey(q);
      if (key === null) return null;
      const url = `https://coins.llama.fi/prices/historical/${String(dayTs(q.date))}/${encodeURIComponent(key)}?searchWidth=6h`;
      const { status, body } = await fetchJson(url);
      if (status !== 200) return null;
      return parseDefiLlama(body, key);
    },
  };
}

/**
 * CoinGecko — secondary price source (ADR-007), keyed by `tokens.coingecko_id`.
 * `/coins/{id}/history?date=DD-MM-YYYY` returns that day's close in USD. Free/demo
 * tier via `x_cg_demo_api_key`. No coingecko id ⇒ null (this token isn't mapped).
 */
import { numberToDecimalString } from '../decimal.js';
import type { DailyPrice, FetchJson, PriceProvider } from './types.js';

/** 'YYYY-MM-DD' → CoinGecko's 'DD-MM-YYYY'. */
function cgDate(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}-${m}-${y}`;
}

export function parseCoinGecko(body: unknown): DailyPrice | null {
  const usd = (body as { market_data?: { current_price?: { usd?: unknown } } }).market_data?.current_price?.usd;
  const price = numberToDecimalString(usd);
  return price === null ? null : { price, currency: 'USD' };
}

export function coinGeckoProvider(fetchJson: FetchJson, apiKey?: string): PriceProvider {
  return {
    source: 'coingecko',
    async dailyPrice(q) {
      if (q.coingeckoId === null) return null;
      const auth = apiKey ? `&x_cg_demo_api_key=${apiKey}` : '';
      const url = `https://api.coingecko.com/api/v3/coins/${q.coingeckoId}/history?date=${cgDate(q.date)}&localization=false${auth}`;
      const { status, body } = await fetchJson(url);
      if (status !== 200) return null;
      return parseCoinGecko(body);
    },
  };
}

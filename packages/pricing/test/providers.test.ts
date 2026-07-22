import { describe, expect, it } from 'vitest';

import { parseCoinGecko } from '../src/providers/coingecko.js';
import { defiLlamaCoinKey, parseDefiLlama } from '../src/providers/defillama.js';
import { parseEcbRange } from '../src/providers/ecb.js';
import { firstPrice } from '../src/providers/provider-factory.js';
import type { PriceProvider, PriceQuery } from '../src/providers/types.js';

const q = (o: Partial<PriceQuery> = {}): PriceQuery =>
  ({ chainSlug: 'ethereum', address: null, coingeckoId: null, date: '2026-06-01', ...o });

describe('DefiLlama adapter', () => {
  it('keys erc20 by chain:address (lowercased), native by coingecko id', () => {
    expect(defiLlamaCoinKey(q({ address: '0xAAbb' }))).toBe('ethereum:0xaabb');
    expect(defiLlamaCoinKey(q({ address: null, coingeckoId: 'ethereum' }))).toBe('coingecko:ethereum');
    expect(defiLlamaCoinKey(q())).toBeNull();
  });

  it('parses a price and canonicalizes it; missing/invalid → null', () => {
    const body = { coins: { 'ethereum:0xabc': { price: 2000.5, decimals: 18, symbol: 'X' } } };
    expect(parseDefiLlama(body, 'ethereum:0xabc')).toEqual({ price: '2000.5', currency: 'USD' });
    expect(parseDefiLlama(body, 'ethereum:0xmissing')).toBeNull();
    expect(parseDefiLlama({ coins: { 'ethereum:0xabc': {} } }, 'ethereum:0xabc')).toBeNull();
  });
});

describe('CoinGecko adapter', () => {
  it('reads market_data.current_price.usd; missing → null', () => {
    expect(parseCoinGecko({ market_data: { current_price: { usd: 1.0001 } } })).toEqual({ price: '1.0001', currency: 'USD' });
    expect(parseCoinGecko({ market_data: { current_price: {} } })).toBeNull();
    expect(parseCoinGecko({})).toBeNull();
  });
});

describe('ECB adapter', () => {
  it('maps SDMX observations to dated rate points', () => {
    const body = {
      dataSets: [{ series: { '0:0:0:0:0': { observations: { '0': [1.08], '1': [1.09] } } } }],
      structure: { dimensions: { observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-05-29' }, { id: '2026-06-01' }] }] } },
    };
    expect(parseEcbRange(body)).toEqual([
      { date: '2026-05-29', quote: 'USD', rate: '1.08' },
      { date: '2026-06-01', quote: 'USD', rate: '1.09' },
    ]);
    expect(parseEcbRange({})).toEqual([]);
  });
});

describe('firstPrice — DefiLlama → CoinGecko failover', () => {
  const stub = (source: string, price: string | null): PriceProvider =>
    ({ source, dailyPrice: () => Promise.resolve(price === null ? null : { price, currency: 'USD' }) });

  it('returns the first non-null source, tagged', async () => {
    expect(await firstPrice([stub('defillama', '2000'), stub('coingecko', '1999')], q())).toEqual({ price: { price: '2000', currency: 'USD' }, source: 'defillama' });
  });

  it('falls back to the next source when the first is null', async () => {
    expect(await firstPrice([stub('defillama', null), stub('coingecko', '1999')], q())).toEqual({ price: { price: '1999', currency: 'USD' }, source: 'coingecko' });
  });

  it('returns null when all sources miss', async () => {
    expect(await firstPrice([stub('defillama', null), stub('coingecko', null)], q())).toBeNull();
  });
});

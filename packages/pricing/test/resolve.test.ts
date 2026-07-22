import { describe, expect, it } from 'vitest';

import type { DecimalString } from '@pet-crypto/core';

import { pickSnapshot } from '../src/resolve.js';
import type { SnapshotRow, ValueNeed } from '../src/types.js';

const s = (id: number, currency: string, source: string, price = '1'): SnapshotRow =>
  ({ id, tokenId: 1, priceDate: '2026-06-01', currency, source, price });
const need = (o: Partial<ValueNeed> = {}): ValueNeed =>
  ({ tokenId: 1, date: '2026-06-01', amount: '1' as DecimalString, isStablecoin: false, pegCurrency: null, ...o });

describe('pickSnapshot — source priority, currency preference, peg policy', () => {
  it('prefers manual > defillama > coingecko', () => {
    const c = [s(1, 'USD', 'coingecko'), s(2, 'USD', 'defillama'), s(3, 'USD', 'manual')];
    expect(pickSnapshot(c, need(), 'USD', 'market')?.id).toBe(3);
  });

  it('prefers a target-currency snapshot over a USD one needing FX', () => {
    const c = [s(1, 'USD', 'defillama'), s(2, 'EUR', 'defillama')];
    expect(pickSnapshot(c, need(), 'EUR', 'market')?.id).toBe(2);
  });

  it('falls back to USD when no target-currency snapshot exists', () => {
    expect(pickSnapshot([s(1, 'USD', 'defillama')], need(), 'EUR', 'market')?.id).toBe(1);
  });

  it('excludes peg rows under market policy', () => {
    const c = [s(1, 'USD', 'peg'), s(2, 'USD', 'defillama')];
    expect(pickSnapshot(c, need(), 'USD', 'market')?.id).toBe(2);
  });

  it('uses the peg row for a stablecoin under peg_for_stables', () => {
    const c = [s(1, 'USD', 'peg'), s(2, 'USD', 'defillama', '0.997')];
    expect(pickSnapshot(c, need({ isStablecoin: true, pegCurrency: 'USD' }), 'USD', 'peg_for_stables')?.id).toBe(1);
  });

  it('values a non-stablecoin at market even under peg_for_stables', () => {
    expect(pickSnapshot([s(1, 'USD', 'defillama')], need(), 'USD', 'peg_for_stables')?.id).toBe(1);
  });

  it('returns undefined when nothing usable exists', () => {
    expect(pickSnapshot([], need(), 'USD', 'market')).toBeUndefined();
    expect(pickSnapshot([s(1, 'USD', 'peg')], need(), 'USD', 'market')).toBeUndefined();
  });

  it('a manual correction outranks the currency preference (manual is authoritative)', () => {
    // manual USD (would need FX) vs coingecko already in the target currency.
    const c = [s(1, 'EUR', 'coingecko'), s(2, 'USD', 'manual')];
    expect(pickSnapshot(c, need(), 'EUR', 'market')?.id).toBe(2);
    // still beats a target-currency defillama row.
    expect(pickSnapshot([s(3, 'EUR', 'defillama'), s(4, 'USD', 'manual')], need(), 'EUR', 'market')?.id).toBe(4);
  });
});

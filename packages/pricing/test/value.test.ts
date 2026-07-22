import { describe, expect, it } from 'vitest';

import type { DecimalString } from '@pet-crypto/core';

import type { FxRow, SnapshotRow, ValueNeed } from '../src/types.js';
import { valueOne } from '../src/value.js';

const ds = (s: string): DecimalString => s as DecimalString;
const need = (over: Partial<ValueNeed> = {}): ValueNeed => ({
  tokenId: 1, date: '2026-06-01', amount: ds('10'), isStablecoin: false, pegCurrency: null, symbol: 'ETH', ...over,
});
const snap = (over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  id: 7, tokenId: 1, priceDate: '2026-06-01', currency: 'USD', price: '2000', source: 'defillama', ...over,
});
const fxRow = (over: Partial<FxRow> = {}): FxRow => ({
  id: 3, rateDate: '2026-06-01', baseCurrency: 'EUR', quoteCurrency: 'USD', rate: '1.08', source: 'ecb', ...over,
});

describe('valueOne — fiat = amount × price (± FX), with pinned refs (C4)', () => {
  it('values in the snapshot currency with no FX', () => {
    const r = valueOne(need({ amount: ds('10') }), snap(), 'USD');
    expect(r.value).toBe('20000');
    expect(r.priceRef).toMatchObject({ snapshotId: 7, currency: 'USD', source: 'defillama', price: '2000' });
    expect(r.fxRef).toBeUndefined();
    expect(r.warning).toBeUndefined();
  });

  it('converts a USD price to EUR by dividing the ECB EUR→USD rate', () => {
    const r = valueOne(need({ amount: ds('10') }), snap(), 'EUR', { row: fxRow(), shifted: false });
    // 10 × 2000 = 20000 USD ; ÷ 1.08 = 18518.5185185…
    expect(r.value.startsWith('18518.5185185185')).toBe(true);
    expect(r.fxRef).toMatchObject({ fxRateId: 3, rate: '1.08', base: 'EUR', quote: 'USD' });
    expect(r.warning).toBeUndefined();
  });

  it('converts a EUR price to USD by multiplying the rate', () => {
    const r = valueOne(need({ amount: ds('10') }), snap({ currency: 'EUR', price: '1850' }), 'USD', { row: fxRow(), shifted: false });
    // 10 × 1850 = 18500 EUR ; × 1.08 = 19980
    expect(r.value).toBe('19980');
  });

  it('flags FX_DATE_SHIFTED when the ECB rate date precedes the target date', () => {
    const r = valueOne(need(), snap(), 'EUR', { row: fxRow({ rateDate: '2026-05-29' }), shifted: true });
    expect(r.warning?.code).toBe('FX_DATE_SHIFTED');
  });

  it('values a peg snapshot at 1.0 (stablecoin under peg policy)', () => {
    const r = valueOne(
      need({ amount: ds('500'), isStablecoin: true, pegCurrency: 'USD', symbol: 'USDC' }),
      snap({ id: 9, currency: 'USD', price: '1', source: 'peg' }),
      'USD',
    );
    expect(r.value).toBe('500');
    expect(r.priceRef).toMatchObject({ snapshotId: 9, source: 'peg', price: '1' });
  });
});

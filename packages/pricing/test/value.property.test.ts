import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { DecimalString } from '@pet-crypto/core';

import type { FxResolved, SnapshotRow, ValueNeed } from '../src/types.js';
import { valueOne } from '../src/value.js';

// Test-side comparison arithmetic at higher precision than production's 40-digit
// clone, so the assertions never round where the code under test doesn't. (The
// production Decimal clone in src/decimal.ts is independent of this global set.)
Decimal.set({ precision: 60, rounding: Decimal.ROUND_HALF_UP });

// Valid decimal strings with a bounded fractional part (so exact-arithmetic
// invariants stay within the 40-significant-digit budget).
const decStr = (maxWhole: number): fc.Arbitrary<string> =>
  fc.tuple(fc.nat(maxWhole), fc.nat(999_999)).map(([w, f]) => `${String(w)}.${String(f).padStart(6, '0')}`);

const need = (amount: string, over: Partial<ValueNeed> = {}): ValueNeed =>
  ({ tokenId: 1, date: '2026-06-01', amount: amount as DecimalString, isStablecoin: false, pegCurrency: null, symbol: 'T', ...over });
const snap = (price: string, currency = 'USD', source = 'defillama'): SnapshotRow =>
  ({ id: 1, tokenId: 1, priceDate: '2026-06-01', currency, price, source });
const fx = (rate: string): FxResolved =>
  ({ row: { id: 1, rateDate: '2026-06-01', baseCurrency: 'EUR', quoteCurrency: 'USD', rate, source: 'ecb' }, shifted: false });

describe('valuation — property invariants', () => {
  it('is homogeneous in amount: value(k·a) = k·value(a)', () => {
    fc.assert(fc.property(decStr(1_000_000), decStr(100_000), fc.nat(1000), (a, p, k) => {
      const v1 = valueOne(need(a), snap(p), 'USD').value;
      const vk = valueOne(need(new Decimal(a).mul(k).toFixed()), snap(p), 'USD').value;
      expect(new Decimal(vk).equals(new Decimal(v1).mul(k))).toBe(true);
    }));
  });

  it('is monotonic in price for a positive amount', () => {
    fc.assert(fc.property(decStr(1_000_000).filter((a) => new Decimal(a).gt(0)), decStr(100_000), decStr(100_000), (a, p1, p2) => {
      const [lo, hi] = new Decimal(p1).lte(p2) ? [p1, p2] : [p2, p1];
      const vlo = valueOne(need(a), snap(lo), 'USD').value;
      const vhi = valueOne(need(a), snap(hi), 'USD').value;
      expect(new Decimal(vlo).lte(vhi)).toBe(true);
    }));
  });

  it('values a peg snapshot (price 1) at exactly the amount', () => {
    fc.assert(fc.property(decStr(1_000_000), (a) => {
      const r = valueOne(need(a, { isStablecoin: true, pegCurrency: 'USD' }), snap('1', 'USD', 'peg'), 'USD');
      expect(new Decimal(r.value).equals(new Decimal(a))).toBe(true);
    }));
  });

  it('USD↔EUR is consistent: converting to EUR then back by the rate recovers the USD value', () => {
    fc.assert(fc.property(decStr(1_000_000), decStr(100_000), fc.integer({ min: 80, max: 150 }), (a, p, r100) => {
      const rate = new Decimal(r100).div(100).toFixed(); // 0.80 … 1.50
      const usd = valueOne(need(a), snap(p), 'USD').value;
      const eur = valueOne(need(a), snap(p), 'EUR', fx(rate)).value;
      const backToUsd = new Decimal(eur).mul(rate);
      // Division truncates at 40 sig-figs; recovery is exact to a relative 1e-20.
      const tol = new Decimal(usd).abs().mul('1e-20').plus('1e-20');
      expect(backToUsd.minus(usd).abs().lte(tol)).toBe(true);
    }));
  });
});

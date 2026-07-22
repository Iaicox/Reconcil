import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { analyticsBalancesInput, analyticsBalancesOutput, decimalString } from '../src/schemas.js';

describe('contract schemas', () => {
  it('decimalString accepts decimal strings, rejects JSON numbers (ADR-004)', () => {
    expect(decimalString.safeParse('123.45').success).toBe(true);
    expect(decimalString.safeParse('-1000000000000000000').success).toBe(true);
    expect(decimalString.safeParse(123.45).success).toBe(false);
    expect(decimalString.safeParse('abc').success).toBe(false);
  });

  it('analyticsBalancesInput is strict (rejects unknown keys)', () => {
    expect(analyticsBalancesInput.safeParse({ valuation: { currency: 'USD' } }).success).toBe(true);
    expect(analyticsBalancesInput.safeParse({}).success).toBe(true);
    expect(analyticsBalancesInput.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it('output schema rejects a fiat_value passed as a number', () => {
    const bad = {
      as_of_effective: { date: '2026-06-01', per_chain: [] },
      balances: [{
        address: '0x', chain_id: 1,
        token: { chain_id: 1, address: null, symbol: 'ETH', decimals: 18, is_stablecoin: false, verified: true },
        amount: '1', fiat_value: 2,
      }],
    };
    expect(analyticsBalancesOutput.safeParse(bad).success).toBe(false);
  });

  it('generates a JSON Schema object for the tool declaration', () => {
    const js = z.toJSONSchema(analyticsBalancesInput) as { type?: string };
    expect(js.type).toBe('object');
  });
});

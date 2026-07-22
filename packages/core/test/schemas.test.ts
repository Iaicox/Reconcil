import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  analyticsBalancesInput, analyticsBalancesOutput, analyticsGasInput, analyticsGasOutput,
  analyticsListEventsInput, analyticsStablecoinInput, analyticsStablecoinOutput, decimalString,
} from '../src/schemas.js';

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

  it('analyticsGasInput: period required, group_by enum constrained, strict', () => {
    expect(analyticsGasInput.safeParse({ period: { from: '2026-06-01', to: '2026-06-30' } }).success).toBe(true);
    expect(analyticsGasInput.safeParse({ period: { from: '2026-06-01', to: '2026-06-30' }, group_by: ['wallet', 'month'] }).success).toBe(true);
    expect(analyticsGasInput.safeParse({ period: { from: '2026-06-01', to: '2026-06-30' }, group_by: ['token'] }).success).toBe(false); // 'token' not a gas dim
    expect(analyticsGasInput.safeParse({}).success).toBe(false); // period required
  });

  it('analyticsGasOutput rejects a native_amount passed as a number', () => {
    expect(analyticsGasOutput.safeParse({ rows: [{ group: { chain: '1' }, native_amount: 5, tx_count: 1 }] }).success).toBe(false);
    expect(analyticsGasOutput.safeParse({ rows: [{ group: { chain: '1' }, native_amount: '5', tx_count: 1 }] }).success).toBe(true);
  });

  it('analyticsStablecoinInput carries no valuation (contract §6.1) and constrains group_by', () => {
    expect(analyticsStablecoinInput.safeParse({ period: { from: '2026-06-01', to: '2026-06-30' }, peg_currency: 'USD' }).success).toBe(true);
    expect(analyticsStablecoinInput.safeParse({ period: { from: '2026-06-01', to: '2026-06-30' }, group_by: ['month'] }).success).toBe(true);
    expect(analyticsStablecoinInput.safeParse({ period: { from: '2026-06-01', to: '2026-06-30' }, group_by: ['day'] }).success).toBe(false); // no 'day' for stablecoins
    expect(analyticsStablecoinInput.safeParse({ period: { from: '2026-06-01', to: '2026-06-30' }, valuation: { currency: 'USD' } }).success).toBe(false); // strict: no valuation
  });

  it('analyticsStablecoinOutput requires peg_subtotals as decimal strings', () => {
    const base = { rows: [], internal_transfers: [] };
    expect(analyticsStablecoinOutput.safeParse({ ...base, peg_subtotals: [{ peg_currency: 'USD', inflow: '10', outflow: '2' }] }).success).toBe(true);
    expect(analyticsStablecoinOutput.safeParse({ ...base, peg_subtotals: [{ peg_currency: 'USD', inflow: 10, outflow: 2 }] }).success).toBe(false);
    expect(analyticsStablecoinOutput.safeParse(base).success).toBe(false); // peg_subtotals required
  });

  it('analyticsListEventsInput bounds limit to ≤200 and rejects unknown keys', () => {
    expect(analyticsListEventsInput.safeParse({ limit: 200 }).success).toBe(true);
    expect(analyticsListEventsInput.safeParse({ limit: 201 }).success).toBe(false);
    expect(analyticsListEventsInput.safeParse({ limit: 1.5 }).success).toBe(false); // int only
    expect(analyticsListEventsInput.safeParse({ kinds: ['erc20_transfer', 'gas_fee'] }).success).toBe(true);
    expect(analyticsListEventsInput.safeParse({ kinds: ['bogus'] }).success).toBe(false);
    expect(analyticsListEventsInput.safeParse({ bogus: 1 }).success).toBe(false);
  });
});

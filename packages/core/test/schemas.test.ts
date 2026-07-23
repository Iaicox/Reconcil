import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  analyticsBalancesInput, analyticsBalancesOutput, analyticsGasInput, analyticsGasOutput,
  analyticsListEventsInput, analyticsStablecoinInput, analyticsStablecoinOutput, decimalString,
  ledgerStatusInput, ledgerStatusOutput, ledgerTraceToolCallInput, ledgerTraceToolCallOutput,
  ledgerTrackWalletInput, ledgerTrackWalletOutput,
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
    // min_amount is non-negative at the boundary (mirrors the ledger guard)
    expect(analyticsListEventsInput.safeParse({ min_amount: '5' }).success).toBe(true);
    expect(analyticsListEventsInput.safeParse({ min_amount: '-5' }).success).toBe(false);
  });
});

describe('ledger_* schemas (§6.2)', () => {
  it('ledgerStatusInput: scope optional, strict', () => {
    expect(ledgerStatusInput.safeParse({}).success).toBe(true);
    expect(ledgerStatusInput.safeParse({ scope: { addresses: ['0xabc'] } }).success).toBe(true);
    expect(ledgerStatusInput.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it('ledgerStatusOutput: streams + integrity, drift amounts are decimal strings', () => {
    const wallet = {
      address: '0xabc', chain_id: 1,
      streams: [{ stream: 'native', status: 'live', last_processed_block: 100, last_block_time: '2026-06-01T00:00:00Z' }],
    };
    expect(ledgerStatusOutput.safeParse({ wallets: [wallet] }).success).toBe(true);
    // integrity drifts must be decimal strings, not JSON numbers (ADR-004)
    const withDrift = (computed: unknown) => ({
      wallets: [{ ...wallet, integrity: { checked_at: '2026-06-01T00:00:00Z', block: 100, clean: false, drifts: [{ token: 'USDC', computed, provider: '5' }] } }],
    });
    expect(ledgerStatusOutput.safeParse(withDrift('4')).success).toBe(true);
    expect(ledgerStatusOutput.safeParse(withDrift(4)).success).toBe(false);
    // stream enum constrained
    expect(ledgerStatusOutput.safeParse({ wallets: [{ ...wallet, streams: [{ stream: 'bogus', status: 'live', last_processed_block: 1, last_block_time: 'x' }] }] }).success).toBe(false);
    // >50k probe estimate surfaces here (async, worker-side), numeric hint
    expect(ledgerStatusOutput.safeParse({ wallets: [{ ...wallet, estimate: { tx_count_hint: 60000, suggests_anchored: true } }] }).success).toBe(true);
    expect(ledgerStatusOutput.safeParse({ wallets: [{ ...wallet, estimate: { tx_count_hint: '60000', suggests_anchored: true } }] }).success).toBe(false);
  });

  it('ledgerTrackWalletInput: address required, mode enum, anchored_from is ISO date, strict', () => {
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC' }).success).toBe(true);
    expect(ledgerTrackWalletInput.safeParse({}).success).toBe(false); // address required
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC', mode: 'anchored', anchored_from: '2026-01-01' }).success).toBe(true);
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC', mode: 'bogus' }).success).toBe(false);
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC', anchored_from: 'yesterday' }).success).toBe(false);
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC', bogus: 1 }).success).toBe(false);
  });

  it('ledgerTrackWalletInput: F4 — anchored_from required for anchored mode, must be a real past date', () => {
    // required when mode='anchored'
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC', mode: 'anchored' }).success).toBe(false);
    // a future anchor date is nonsensical (no history to seed a baseline for)
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC', mode: 'anchored', anchored_from: '2999-01-01' }).success).toBe(false);
    // format-valid but not a real calendar date (Feb 30) — rejected, not rolled over
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC', mode: 'anchored', anchored_from: '2024-02-30' }).success).toBe(false);
    // mode='full' (default) with no anchored_from stays valid
    expect(ledgerTrackWalletInput.safeParse({ address: '0xABC', mode: 'full' }).success).toBe(true);
  });

  it('ledgerTrackWalletOutput: enqueued rows; estimate lives on ledger_status, not here', () => {
    const base = { wallet_id: 'w1', enqueued: [{ chain_id: 1, stream: 'native', job_id: 'backfill:1:0xabc:native' }] };
    expect(ledgerTrackWalletOutput.safeParse(base).success).toBe(true);
    // an anchored track reports anchor job ids
    expect(ledgerTrackWalletOutput.safeParse({ wallet_id: 'w1', enqueued: [{ chain_id: 1, stream: 'native', job_id: 'anchor:1:0xabc:native' }] }).success).toBe(true);
    // a malformed enqueued row (missing job_id) is rejected
    expect(ledgerTrackWalletOutput.safeParse({ wallet_id: 'w1', enqueued: [{ chain_id: 1, stream: 'native' }] }).success).toBe(false);
  });

  it('ledgerTraceToolCallInput/Output: id required; coverage is CoverageRef[]', () => {
    expect(ledgerTraceToolCallInput.safeParse({ tool_call_id: '01J' }).success).toBe(true);
    expect(ledgerTraceToolCallInput.safeParse({}).success).toBe(false);
    const out = {
      tool_name: 'analytics_balances', args: {}, called_at: '2026-06-01T00:00:00Z',
      coverage: [{ chain_id: 1, address: '0xabc', streams: ['native'], from_block: null, to_block: 100, status: 'live' }],
      result_digest: 'a'.repeat(64),
    };
    expect(ledgerTraceToolCallOutput.safeParse(out).success).toBe(true);
    expect(ledgerTraceToolCallOutput.safeParse({ ...out, drilldown: { tool: 'analytics_list_events', args: {} } }).success).toBe(true);
  });
});

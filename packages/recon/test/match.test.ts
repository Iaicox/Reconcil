import { describe, expect, it } from 'vitest';

import { deriveRecordStatus, suggestForRecord } from '../src/index.js';
import type { CandidateEvent, MatchRecord, Tolerances } from '../src/index.js';

const ADDR = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;

const record = (over: Partial<MatchRecord> = {}): MatchRecord => ({
  id: 'r1',
  amount: '1000.00',
  openAmount: '1000.00',
  currency: 'EUR',
  issuedOn: '2026-06-01',
  dueOn: '2026-06-15',
  expectedAddress: ADDR,
  knownCounterpartyAddresses: [],
  ...over,
});

// 1000.00 of a 6-decimal stablecoin = 1_000_000_000 base units; valued at face.
const ev = (over: Partial<CandidateEvent> = {}): CandidateEvent => ({
  eventId: 1,
  amountRaw: 1_000_000_000n,
  tokenDecimals: 6,
  valuedAmount: '1000.00',
  blockTime: '2026-06-14T12:00:00Z',
  fromAddr: ADDR,
  ...over,
});

const ruleSet = (legIdx: number, legs: ReturnType<typeof suggestForRecord>): string[] =>
  legs[legIdx]!.rationale.map((r) => r.rule).sort();

describe('suggestForRecord — single-event matching', () => {
  it('scores an exact match from the expected address highest, with amount+address+date rules', () => {
    const legs = suggestForRecord(record(), [ev()]);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.eventId).toBe(1);
    expect(legs[0]!.amountAppliedRaw).toBe(1_000_000_000n);
    expect(legs[0]!.fiatValue).toBe('1000.00');
    expect(legs[0]!.confidence).toBeGreaterThan(0.85);
    expect(ruleSet(0, legs)).toEqual(['address', 'amount', 'date']);
    // Confidence is reproducible from the rationale: Σ weights === confidence.
    const sum = legs[0]!.rationale.reduce((acc, r) => acc + r.weight, 0);
    expect(sum).toBeCloseTo(legs[0]!.confidence, 10);
  });

  it('suggests a partial payment from the expected sender (amount rule does not fire)', () => {
    const legs = suggestForRecord(record(), [ev({ valuedAmount: '400.00', amountRaw: 400_000_000n })]);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.fiatValue).toBe('400.00');
    expect(ruleSet(0, legs)).not.toContain('amount'); // way under open → amount score 0
    expect(ruleSet(0, legs)).toContain('address');
  });

  it('suggests an overpayment from the expected sender', () => {
    const legs = suggestForRecord(record(), [ev({ valuedAmount: '1500.00', amountRaw: 1_500_000_000n })]);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.amountAppliedRaw).toBe(1_500_000_000n);
  });

  it('offers nothing for an unrelated event (amount off, unknown sender, in window)', () => {
    const legs = suggestForRecord(record(), [ev({ fromAddr: OTHER, valuedAmount: '400.00' })]);
    expect(legs).toEqual([]);
  });

  it('a known-counterparty address fires the history rule', () => {
    const legs = suggestForRecord(
      record({ expectedAddress: null, knownCounterpartyAddresses: [OTHER] }),
      [ev({ fromAddr: OTHER, valuedAmount: '400.00' })],
    );
    expect(legs).toHaveLength(1);
    expect(ruleSet(0, legs)).toContain('history');
  });
});

describe('suggestForRecord — tolerance and window boundaries', () => {
  it('honors an absolute amount band (in, then out)', () => {
    const tol: Tolerances = { amountPct: 0, amountAbs: '5.00' };
    const near = suggestForRecord(record(), [ev({ valuedAmount: '1004.00', fromAddr: OTHER })], tol);
    expect(near).toHaveLength(1); // qualifies on amount alone
    const far = suggestForRecord(record(), [ev({ valuedAmount: '1006.00', fromAddr: OTHER })], tol);
    expect(far).toEqual([]);
  });

  it('excludes events outside the date window', () => {
    const inWin = suggestForRecord(record(), [ev({ blockTime: '2026-06-29T00:00:00Z' })]); // 14d from due
    expect(inWin).toHaveLength(1);
    const outWin = suggestForRecord(record(), [ev({ blockTime: '2026-06-30T00:00:00Z' })]); // 15d
    expect(outWin).toEqual([]);
  });

  it('an expected-address hit raises confidence over the same event from an unknown sender', () => {
    const withAddr = suggestForRecord(record(), [ev()]);
    const noAddr = suggestForRecord(record(), [ev({ fromAddr: OTHER })]);
    expect(withAddr[0]!.confidence).toBeGreaterThan(noAddr[0]!.confidence);
  });

  it('is deterministic: identical inputs produce identical confidence and rationale', () => {
    const events = [ev(), ev({ eventId: 2, fromAddr: OTHER, valuedAmount: '999.00', amountRaw: 999_000_000n })];
    expect(suggestForRecord(record(), events)).toEqual(suggestForRecord(record(), events));
  });
});

describe('suggestForRecord — bounded subset (split) search', () => {
  it('proposes a split of two events that sum to the open amount', () => {
    const e1 = ev({ eventId: 1, valuedAmount: '600.00', amountRaw: 600_000_000n, fromAddr: OTHER });
    const e2 = ev({ eventId: 2, valuedAmount: '400.00', amountRaw: 400_000_000n, fromAddr: OTHER });
    const legs = suggestForRecord(record(), [e1, e2]);
    expect(legs.map((l) => l.eventId).sort()).toEqual([1, 2]);
    expect(legs[0]!.confidence).toBeCloseTo(legs[1]!.confidence, 10); // shared subset confidence
    expect(legs[0]!.rationale.map((r) => r.rule)).toContain('amount');
  });

  it('leaves a record open when only a >6-event combination would settle it (honest failure)', () => {
    const rec = record({ amount: '700.00', openAmount: '700.00' });
    const events = Array.from({ length: 7 }, (_unused, i) =>
      ev({ eventId: i + 1, valuedAmount: '100.00', amountRaw: 100_000_000n, fromAddr: OTHER }));
    expect(suggestForRecord(rec, events)).toEqual([]);
  });
});

describe('deriveRecordStatus', () => {
  it('derives status from confirmed applied vs full amount, within tolerance', () => {
    expect(deriveRecordStatus('1000.00', '0')).toBe('open');
    expect(deriveRecordStatus('1000.00', '1000.00')).toBe('matched');
    expect(deriveRecordStatus('1000.00', '1005.00')).toBe('matched'); // inside the 1% band
    expect(deriveRecordStatus('1000.00', '400.00')).toBe('partially_matched');
    expect(deriveRecordStatus('1000.00', '1200.00')).toBe('overpaid');
  });
});

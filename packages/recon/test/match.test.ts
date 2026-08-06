import { describe, expect, it } from 'vitest';

import { deriveRecordStatus, suggestForRecord } from '../src/index.js';
import type { CandidateEvent, MatchRecord, Tolerances } from '../src/index.js';
import { computeBand, toMinor } from '../src/match/score.js';

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
  counterpartyAddr: ADDR,
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
    // Confidence is reproducible from the rationale: Σ weights === confidence, EXACTLY
    // (A3) — not approximately, so the rescale-under-the-hood makes this equality real.
    const sum = legs[0]!.rationale.reduce((acc, r) => acc + r.weight, 0);
    expect(sum).toBe(legs[0]!.confidence);
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
    const legs = suggestForRecord(record(), [ev({ counterpartyAddr: OTHER, valuedAmount: '400.00' })]);
    expect(legs).toEqual([]);
  });

  it('never offers a zero-amount transfer, even from the expected sender', () => {
    // A 0-value spam transfer from the expected payer would pass the address gate but
    // produce an amountAppliedRaw of 0 — invalid downstream. It must be dropped.
    const legs = suggestForRecord(record(), [ev({ amountRaw: 0n, valuedAmount: '0' })]);
    expect(legs).toEqual([]);
  });

  it('a known-counterparty address fires the history rule', () => {
    const legs = suggestForRecord(
      record({ expectedAddress: null, knownCounterpartyAddresses: [OTHER] }),
      [ev({ counterpartyAddr: OTHER, valuedAmount: '400.00' })],
    );
    expect(legs).toHaveLength(1);
    expect(ruleSet(0, legs)).toContain('history');
  });
});

describe('suggestForRecord — band-edge suggestions require an articulable reason (H18)', () => {
  it('drops a candidate exactly on the tolerance-band edge when nothing else fired (no 0-confidence leg)', () => {
    const rec = record({ issuedOn: null, dueOn: null, expectedAddress: null });
    // 1010.00 is exactly openAmount(1000.00) + the default 1% band(10.00): withinBand is
    // inclusive (<=) but amountScore treats the edge as 0 (score.ts diff >= bandMinor).
    // With no dates/address/history to fire either, there is no articulable reason — the
    // engine must emit NO leg, not one with confidence 0 and empty rationale (C1).
    const edge = ev({ valuedAmount: '1010.00', amountRaw: 1_010_000_000n, counterpartyAddr: OTHER });
    expect(suggestForRecord(rec, [edge])).toEqual([]);
  });

  it('the same edge event still suggests once a real signal (address) fires', () => {
    const rec = record({ issuedOn: null, dueOn: null, expectedAddress: ADDR });
    const edge = ev({ valuedAmount: '1010.00', amountRaw: 1_010_000_000n, counterpartyAddr: ADDR });
    const legs = suggestForRecord(rec, [edge]);
    expect(legs).toHaveLength(1);
    expect(ruleSet(0, legs)).toEqual(['address']);
    expect(legs[0]!.confidence).toBe(0.35);
  });
});

describe('suggestForRecord — zero-open-amount records (A4/A5)', () => {
  it('emits no legs for a record with nothing outstanding, even from the expected sender', () => {
    // A5: without this guard, every payment from the expected sender would become a
    // suggested leg on an invoice that has nothing left to settle.
    expect(suggestForRecord(record({ amount: '0.00', openAmount: '0.00' }), [ev()])).toEqual([]);
  });
});

describe('suggestForRecord — tolerance and window boundaries', () => {
  it('honors an absolute amount band (in, then out)', () => {
    const tol: Tolerances = { amountPct: 0, amountAbs: '5.00' };
    const near = suggestForRecord(record(), [ev({ valuedAmount: '1004.00', counterpartyAddr: OTHER })], tol);
    expect(near).toHaveLength(1); // qualifies on amount alone
    const far = suggestForRecord(record(), [ev({ valuedAmount: '1006.00', counterpartyAddr: OTHER })], tol);
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
    const noAddr = suggestForRecord(record(), [ev({ counterpartyAddr: OTHER })]);
    expect(withAddr[0]!.confidence).toBeGreaterThan(noAddr[0]!.confidence);
  });

  it('is deterministic: identical inputs produce identical confidence and rationale', () => {
    const events = [ev(), ev({ eventId: 2, counterpartyAddr: OTHER, valuedAmount: '999.00', amountRaw: 999_000_000n })];
    expect(suggestForRecord(record(), events)).toEqual(suggestForRecord(record(), events));
  });
});

describe('suggestForRecord — bounded subset (split) search', () => {
  it('proposes a split of two events that sum to the open amount', () => {
    const e1 = ev({ eventId: 1, valuedAmount: '600.00', amountRaw: 600_000_000n, counterpartyAddr: OTHER });
    const e2 = ev({ eventId: 2, valuedAmount: '400.00', amountRaw: 400_000_000n, counterpartyAddr: OTHER });
    const legs = suggestForRecord(record(), [e1, e2]);
    expect(legs.map((l) => l.eventId).sort()).toEqual([1, 2]);
    expect(legs[0]!.confidence).toBe(legs[1]!.confidence); // shared subset confidence (same scoreCandidate call)
    expect(legs[0]!.rationale.map((r) => r.rule)).toContain('amount');
  });

  it('leaves a record open when only a >6-event combination would settle it (honest failure)', () => {
    const rec = record({ amount: '700.00', openAmount: '700.00' });
    const events = Array.from({ length: 7 }, (_unused, i) =>
      ev({ eventId: i + 1, valuedAmount: '100.00', amountRaw: 100_000_000n, counterpartyAddr: OTHER }));
    expect(suggestForRecord(rec, events)).toEqual([]);
  });

  it('also leaves a record open when the exact split needs a member outside the top-6-by-size pool (known limitation, req 5)', () => {
    // The pool is the 6 LARGEST candidates, not "any 6". Here the true split is
    // 650.00 + 50.00 = 700.00, but five 100.00 decoys crowd the 50.00 leg out of the
    // top-6 pool (650 + five 100s already fill it), so the search never sees it. This
    // is the honest, documented blind spot (engine.ts header) distinct from the
    // "needs >6 events" case above — a characterization test, not a red one: it pins
    // TODAY's behavior so a future widening of the pool selection flips it consciously.
    const rec = record({ amount: '700.00', openAmount: '700.00' });
    const big = ev({ eventId: 1, valuedAmount: '650.00', amountRaw: 650_000_000n, counterpartyAddr: OTHER });
    const decoys = Array.from({ length: 5 }, (_unused, i) =>
      ev({ eventId: i + 2, valuedAmount: '100.00', amountRaw: 100_000_000n, counterpartyAddr: OTHER }));
    const small = ev({ eventId: 7, valuedAmount: '50.00', amountRaw: 50_000_000n, counterpartyAddr: OTHER });
    expect(suggestForRecord(rec, [big, ...decoys, small])).toEqual([]);
  });
});

describe('computeBand — amount_pct resolves to 4 decimal places (A6)', () => {
  it('a 0.004% tolerance produces a real, non-zero band', () => {
    const band = computeBand('1000000.00', { amountPct: 0.004 });
    // 0.004% of 1,000,000.00 = 40.00. The old e2 rounding (Math.round(pct * 100)) rounded
    // 0.004 to 0 basis points and collapsed this band to abs-only (0) — no signal at all.
    expect(band.bandMinor).toBe(toMinor('40'));
  });

  it('precision finer than e4 still rounds — documented, not an error', () => {
    const band = computeBand('1000000.00', { amountPct: 0.00004 });
    expect(band.bandMinor).toBe(0n); // rounds to 0 scaled units → band = abs only
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

  it('a genuinely zero-amount record with nothing applied is matched, not stuck open forever (A4)', () => {
    expect(deriveRecordStatus('0', '0')).toBe('matched');
    expect(deriveRecordStatus('0.00', '0.00')).toBe('matched');
  });

  it('any payment against a zero-amount record is an overpayment', () => {
    expect(deriveRecordStatus('0.00', '10.00')).toBe('overpaid');
  });
});

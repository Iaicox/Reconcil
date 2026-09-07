/**
 * Model-based property coverage for the confidence-scoring invariant (A3, score.ts).
 * `scoreCandidate` must satisfy `Σ rationale.weight === confidence` EXACTLY — not
 * merely approximately — even in the rare case where float summation of the fired
 * contributions lands a hair above 1 and the rescale-instead-of-clamp path fires.
 * The generator runs amounts down to (and including) 0 and small values, since that
 * is where the tolerance-band edge cases (H18, A6) live.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { computeBand, scoreCandidate } from '../src/match/score.js';
import type { CandidateEvent, MatchRecord, Tolerances } from '../src/match/types.js';

const ADDR = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const KNOWN = `0x${'c'.repeat(40)}`;

/** A 2-dp decimal string from non-negative integer cents (keeps money off floats). */
const dec = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

/** An ISO UTC datetime whose `dayNumber` is exactly `day` (day index × 1 day). */
const dayIso = (day: number): string => new Date(day * 86_400_000).toISOString();

const eventArb = fc.record({
  eventId: fc.integer({ min: 1, max: 1000 }),
  valuedAmountCents: fc.integer({ min: 0, max: 2_000_000 }), // includes 0 and small values
  counterparty: fc.constantFrom(ADDR, OTHER, KNOWN),
  dayOffset: fc.integer({ min: -40, max: 40 }),
});

describe('scoreCandidate — Σ rationale.weight === confidence, exactly (A3)', () => {
  it('holds for randomized records, tolerances, and single/multi-event candidates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }), // open amount in cents, includes 0
        fc.integer({ min: 0, max: 100_000 }).map((n) => n / 10_000), // amount_pct at e4 resolution, 0..10
        fc.integer({ min: 0, max: 5_000 }), // amount_abs in cents
        fc.integer({ min: 0, max: 30 }), // date window days
        fc.option(fc.integer({ min: -20, max: 20 }), { nil: null }), // reference day (null = no reference date)
        fc.constantFrom<string | null>(ADDR, OTHER, null), // expectedAddress
        fc.array(eventArb, { minLength: 1, maxLength: 4 }),
        (openCents, amountPct, absCents, windowDays, refDay, expectedAddress, events) => {
          const openAmount = dec(openCents);
          const tolerances: Tolerances = { amountPct, amountAbs: dec(absCents), dateWindowDays: windowDays };
          const band = computeBand(openAmount, tolerances);
          const record: MatchRecord = {
            id: 'r',
            amount: openAmount,
            openAmount,
            currency: 'EUR',
            issuedOn: null,
            dueOn: null,
            expectedAddress,
            knownCounterpartyAddresses: [KNOWN],
          };
          const candidateEvents: CandidateEvent[] = events.map((e) => ({
            eventId: e.eventId,
            amountRaw: 1n, // irrelevant to scoreCandidate — it scores `valuedAmount`
            tokenDecimals: 6,
            valuedAmount: dec(e.valuedAmountCents),
            blockTime: dayIso(e.dayOffset),
            counterpartyAddr: e.counterparty,
          }));

          const { confidence, rationale } = scoreCandidate({
            record, events: candidateEvents, band, refDay, windowDays,
          });

          // Re-summing the SHIPPED rationale must land on the SHIPPED confidence exactly —
          // not toBeCloseTo. This is what "reproducible from the rationale" (P1) means.
          const sum = rationale.reduce((acc, r) => acc + r.weight, 0);
          expect(sum).toBe(confidence);
          expect(confidence).toBeGreaterThanOrEqual(0);
          expect(confidence).toBeLessThanOrEqual(1);
          for (const r of rationale) expect(r.weight).toBeGreaterThanOrEqual(0); // stays non-negative
        },
      ),
      { numRuns: 500 },
    );
  });
});

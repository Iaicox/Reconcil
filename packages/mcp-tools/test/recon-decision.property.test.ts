/**
 * Model-based property coverage for the confirm/reject invariants (04-testing.md §7).
 * These are hermetic — they pin the *algebra* the SERIALIZABLE repo implements
 * (decision-repo.ts), while recon-confirm-reject.itest.ts proves the SQL implements it:
 *   #2 record status is a monotone pure function of confirmed fiat (real deriveRecordStatus);
 *   #1/#7 an event is never over-applied by any permutation of confirm/reject decisions.
 */
import { deriveRecordStatus, type DerivedRecordStatus } from '@reconcil/recon';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const RANK: Record<DerivedRecordStatus, number> = { open: 0, partially_matched: 1, matched: 2, overpaid: 3 };

/** A 2-dp decimal string from integer cents (keeps money off floats). */
const dec = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

describe('deriveRecordStatus — invariant #2 (status is a monotone pure function of confirmed fiat)', () => {
  it('is open at zero, bounded to the four derivable states, and non-decreasing in applied fiat', () => {
    fc.assert(
      fc.property(
        // Invoice amount in cents, including 0 (A4: a genuinely zero-amount record is
        // 'matched' at zero applied, not 'open' — the band {0,0} already contains 0).
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 2_000_000 }), { minLength: 1, maxLength: 8 }),
        (amountCents, appliedList) => {
          const amount = dec(amountCents);
          expect(deriveRecordStatus(amount, '0.00')).toBe(amountCents === 0 ? 'matched' : 'open');

          let prevRank = -1;
          for (const cents of [...appliedList].sort((a, b) => a - b)) {
            const status = deriveRecordStatus(amount, dec(cents));
            expect(status in RANK).toBe(true);
            expect(RANK[status]).toBeGreaterThanOrEqual(prevRank); // never moves backward
            prevRank = RANK[status];
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('confirm/reject sequencing — invariant #1/#7 (an event is never over-applied, in any order)', () => {
  it('keeps Σ confirmed applied ≤ event capacity for every decision permutation', () => {
    const leg = fc.record({
      applied: fc.integer({ min: 1, max: 50 }),
      decide: fc.constantFrom<'confirm' | 'reject'>('confirm', 'reject'),
      key: fc.integer(), // sort key → the decision order for this run
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }), // event capacity (base units)
        fc.array(leg, { minLength: 1, maxLength: 8 }),
        (cap, legs) => {
          const capB = BigInt(cap);
          const status: ('suggested' | 'confirmed' | 'rejected')[] = legs.map(() => 'suggested');
          const confirmedSum = (): bigint =>
            legs.reduce((acc, l, i) => (status[i] === 'confirmed' ? acc + BigInt(l.applied) : acc), 0n);

          const order = legs.map((_, i) => i).sort((a, b) => legs[a]!.key - legs[b]!.key);
          for (const i of order) {
            if (status[i] !== 'suggested') continue; // a re-decision is a no-op (NOT_SUGGESTED)
            if (legs[i]!.decide === 'reject') {
              status[i] = 'rejected';
            } else if (confirmedSum() + BigInt(legs[i]!.applied) <= capB) {
              status[i] = 'confirmed'; // otherwise MATCH_CONFLICT: no state change
            }
            expect(confirmedSum() <= capB).toBe(true); // invariant holds after every step
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

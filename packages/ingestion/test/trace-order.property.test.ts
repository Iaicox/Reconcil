/**
 * `compareTraceIds` must be a CONSISTENT comparator — a strict weak ordering — because
 * `Array.prototype.sort` is only defined for one. Its output feeds `sentinelRank`, which
 * becomes the `log_index` sentinel on every internal transfer, which is half the
 * `UNIQUE (chain_id, tx_hash, log_index, token_id)` idempotency key (ADR-005). A comparator
 * that contradicts itself makes that assignment depend on the engine's sort implementation
 * and on the input's arrival order.
 *
 * The concrete pre-fix violation, which the transitivity property below rediscovers:
 *   "9" < "10"   (both numeric)
 *   "10" < "1a"  (one non-numeric → string compare)
 *   "9"  > "1a"  (string compare: '9' > '1')
 * — a cycle. Segments were classified with `Number(...)`, which also reads "" as 0, "0x10"
 * as 16 and "1e3" as 1000.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareTraceIds } from '../src/normalize.js';

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Segments chosen to mix the numeric and non-numeric classes inside one id. */
const segment = fc.constantFrom('0', '1', '2', '9', '10', '11', '100', 'a', 'z', '1a', 'a1', '', '0x10', '1e3', '007');
const traceId = fc.array(segment, { minLength: 1, maxLength: 3 }).map((xs) => xs.join('_'));

describe('compareTraceIds is a consistent comparator', () => {
  it('is antisymmetric: cmp(a,b) and cmp(b,a) have opposite signs', () => {
    // Summed rather than negated-and-compared: -sign(0) is -0, and toBe uses Object.is,
    // which separates -0 from 0. The sum is 0 for both the equal and the ordered case.
    fc.assert(
      fc.property(traceId, traceId, (a, b) => {
        expect(sign(compareTraceIds(a, b)) + sign(compareTraceIds(b, a))).toBe(0);
      }),
      { numRuns: 2000 },
    );
  });

  it('is reflexive: cmp(a,a) === 0', () => {
    fc.assert(fc.property(traceId, (a) => { expect(compareTraceIds(a, a)).toBe(0); }), { numRuns: 500 });
  });

  it('is transitive: a < b and b < c implies a < c', () => {
    fc.assert(
      fc.property(traceId, traceId, traceId, (a, b, c) => {
        if (compareTraceIds(a, b) < 0 && compareTraceIds(b, c) < 0) {
          expect(compareTraceIds(a, c)).toBeLessThan(0);
        }
      }),
      { numRuns: 5000 },
    );
  });

  it('rediscovers the exact pre-fix cycle', () => {
    expect(compareTraceIds('9', '10')).toBeLessThan(0);
    expect(compareTraceIds('10', '1a')).toBeLessThan(0);
    // Pre-fix this returned 1 — "9" sorted after "1a" by raw string comparison.
    expect(compareTraceIds('9', '1a')).toBeLessThan(0);
  });

  it('still orders real Etherscan trace ids numerically, not lexically', () => {
    // The only shape that occurs in practice: digits and underscores. 2 < 10 must hold.
    expect(compareTraceIds('2', '10')).toBeLessThan(0);
    expect(compareTraceIds('0_2', '0_10')).toBeLessThan(0);
    expect(compareTraceIds('0_1', '0_1_0')).toBeLessThan(0);
    // Leading zeros are the same NUMBER, so the segment comparison is a tie — but the two
    // labels are distinct, so the comparator must still separate them rather than return 0
    // and let the caller's arrival-order tiebreak decide (ADR-005 d2).
    expect(compareTraceIds('007', '7')).toBeLessThan(0);
    expect(compareTraceIds('7', '007')).toBeGreaterThan(0);
  });

  it('never returns 0 for two DISTINCT labels — the caller must not fall to arrival order', () => {
    // The sentinel log_index is assigned from this sort, and it is half the ADR-005
    // idempotency key. A tie between distinct labels hands that assignment to the
    // provider's response order, which a re-fetch or a failover can invert.
    fc.assert(
      fc.property(traceId, traceId, (a, b) => {
        if (a !== b) expect(compareTraceIds(a, b)).not.toBe(0);
      }),
      { numRuns: 3000 },
    );
  });

  it('separates numbers that a float would collapse — the reason this is not Number()', () => {
    // 2^53 and 2^53+1 are the same IEEE double. The comparison is digit-based, so they are
    // not the same trace label, and the sentinel derived from their order stays distinct.
    expect(Number('9007199254740993')).toBe(Number('9007199254740992')); // the trap
    expect(compareTraceIds('9007199254740993', '9007199254740992')).toBeGreaterThan(0);
    expect(compareTraceIds('9007199254740992', '9007199254740993')).toBeLessThan(0);
  });

  it('ignores leading zeros when comparing magnitude, at any length', () => {
    expect(compareTraceIds('0000000009', '10')).toBeLessThan(0);
    expect(compareTraceIds('00042', '42')).toBeLessThan(0); // equal as numbers, split by the label tiebreak
    // Equal as numbers, so the whole-label tiebreak decides — and it is the raw string, so
    // the shorter label sorts first. Pinned because '0' vs '00' is the shape where a
    // leading-zero skip that ran off the end would read one of them as empty.
    expect(compareTraceIds('0', '00')).toBeLessThan(0);
  });

  it('does not read non-decimal notations as numbers', () => {
    // Number('0x10') is 16 and Number('1e3') is 1000 — neither is a trace-id segment,
    // and treating them as numeric put them in the wrong class.
    expect(compareTraceIds('0x10', '9')).toBeGreaterThan(0); // non-numeric sorts after numeric
    expect(compareTraceIds('1e3', '9')).toBeGreaterThan(0);
    expect(compareTraceIds('', '0')).toBeGreaterThan(0); // '' is not the number zero
  });
});

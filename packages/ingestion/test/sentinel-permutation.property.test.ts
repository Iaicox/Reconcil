/**
 * The `-(1000+n)` sentinel on every internal transfer is half of the append-only
 * `UNIQUE (chain_id, tx_hash, log_index, token_id)` idempotency key (ADR-005 d2). The
 * property that key must have is that it is a function of the ROW SET: a re-fetch returning
 * the same traces in a different order — the overlap-by-one boundary block, or the other
 * provider after a failover — has to re-derive the same slot for the same row, or
 * `ON CONFLICT DO NOTHING` stops matching, one real value movement is stored twice and
 * another is lost.
 *
 * This file asserts that directly, over permutations of the page.
 *
 * It deliberately does NOT assert that the MULTISET of emitted keys is permutation-invariant,
 * which is the shape this test was first drafted as. That assertion is vacuous:
 * `normalize()` assigns `n` as a rank within a parent-tx group, so a group of k rows always
 * emits exactly {-1000 … -(999+k)} whatever the comparator returns — including under
 * `sort((a, b) => a.arrival - b.arrival)`, the one thing ADR-005 d2 forbids. A test that stays
 * green under the mutation it exists to catch is worse than no test at all. The assertion that
 * does the work is the row-identity → key MAP: which specific trace landed in which slot.
 *
 * Replaces `trace-order.property.test.ts`, which pinned the total-ordering properties of a
 * trace-LABEL comparator that no longer exists (ADR-005 d2, amended 2026-09-15).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalize } from '../src/normalize.js';
import type { NormalizeContext } from '../src/normalize.js';
import type { NormalizedEvent, RawInternalTx } from '../src/types.js';

const CTX: NormalizeContext = {
  chainId: 1,
  trackedAddress: '0xAbCd000000000000000000000000000000000001',
  feeStrategy: 'txlist',
  provider: 'etherscan-v2',
};

const HASH = '0xDD10000000000000000000000000000000000000000000000000000000000010';

/**
 * A deliberately tiny endpoint pool, so two generated rows routinely agree on two of the
 * three tuple components and only the third separates them. A wide pool would make almost
 * every pair differ in `value` alone and leave the `from` and `to` branches of the comparator
 * unexercised — the generator could then not go red on a mutation deleting either. (Measured
 * over 3000 seeded runs: ~570 pairs differing only in `from`, ~600 only in `to`.)
 *
 * One entry is a mixed-case spelling of another, which exercises the parent-tx grouping but
 * **not** the comparator's `toLowerCase()`: `uniqueArray`'s selector dedupes on the LOWERCASED
 * tuple, so two rows differing only in address case can never co-occur in a generated set, and
 * dropping `toLowerCase()` from the comparator leaves it a deterministic function of row
 * content — permutation invariance still holds. That mutation is pinned by an explicit case in
 * `normalize.test.ts` ("address casing cannot change the order") instead. Said here because a
 * docstring claiming a property the generator cannot reach is the failure this whole file is
 * about.
 */
const ADDRS = [
  '0xaa00000000000000000000000000000000000001',
  '0xAA00000000000000000000000000000000000001',
  '0xbb00000000000000000000000000000000000002',
  '0xcc00000000000000000000000000000000000003',
] as const;

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const VALUES = ['1', '2', '400', '900', '1000000000000000000', MAX_UINT256] as const;

/**
 * Every label shape the deleted comparator had a rule for — leading zeros, non-decimal
 * notations, an empty segment, the empty string, absence — plus ordinary ones. None of them
 * may move a single sentinel now; "is independent of the trace label" below is what says so.
 */
const LABELS = [undefined, '', '0', '1', '2', '10', '0_1', '0_2', '007', '1a', '0x10', '0_'] as const;

/**
 * The same parent tx, spelled two ways. A provider is free to return either, and `normalize()`
 * folds them into one group with `hash.toLowerCase()`. Varying it here is what lets the
 * distinctness property below go red if that fold is ever dropped: two spellings would become
 * two groups, each numbering from -1000, and the collision is the ADR-005 double-insert.
 */
const HASHES = [HASH, HASH.toLowerCase()] as const;

interface TraceSpec {
  hash: string;
  from: string;
  to: string;
  value: string;
  traceId: string | undefined;
}

const tupleKey = (r: { from: string; to: string; value: string }): string =>
  `${r.from.toLowerCase()}|${r.to.toLowerCase()}|${BigInt(r.value).toString()}`;

const traceArb: fc.Arbitrary<TraceSpec> = fc.record({
  hash: fc.constantFrom(...HASHES),
  from: fc.constantFrom(...ADDRS),
  to: fc.constantFrom(...ADDRS),
  value: fc.constantFrom(...VALUES),
  traceId: fc.constantFrom(...LABELS),
});

/**
 * Distinct tuples only. A tied tuple is precisely the case where the slot is NOT a function
 * of the row, and that exclusion is pinned by its own test at the bottom of this file rather
 * than hidden by generating around it.
 */
const groupArb = fc.uniqueArray(traceArb, { minLength: 2, maxLength: 5, selector: tupleKey });

const rowOf = (r: TraceSpec): RawInternalTx => ({
  blockNumber: '19000010',
  timeStamp: '1700001000',
  hash: r.hash,
  from: r.from,
  to: r.to,
  value: r.value,
  isError: '0',
  traceId: r.traceId,
});

/** tuple identity → the sentinel that row landed on: "which trace got which slot". */
function slots(rows: readonly RawInternalTx[]): Record<string, number> {
  const events = normalize({ internal: { items: [...rows] } }, CTX);
  return Object.fromEntries(
    events.map((e) => [`${e.fromAddr}|${e.toAddr}|${e.amountRaw.toString()}`, e.logIndex]),
  );
}

/**
 * Every ordering of `xs`. Exhaustive rather than sampled: generated sets are at most 5 rows,
 * so 120 orderings is cheap and proves the property for that set outright instead of
 * probably.
 */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += 1) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([xs[i]!, ...tail]);
  }
  return out;
}

describe('the internal-transfer sentinel is a function of the row set (ADR-005 d2)', () => {
  it('gives every trace the same slot under every ordering of the page', () => {
    fc.assert(
      fc.property(groupArb, (specs) => {
        const rows = specs.map(rowOf);
        const expected = slots(rows);
        for (const p of permutations(rows)) expect(slots(p)).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('never hands two traces in one tx the same slot', () => {
    fc.assert(
      fc.property(groupArb, (specs) => {
        const rows = specs.map(rowOf);
        for (const p of permutations(rows)) {
          expect(new Set(Object.values(slots(p))).size).toBe(rows.length);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('is independent of the trace label', () => {
    // The sweeping form of "the label is no longer a rank source": for the SAME rows, the
    // slots must not move when every label is stripped. Reintroducing any label-derived
    // ordering makes this red as soon as label order and tuple order disagree, which the
    // label pool above guarantees they will.
    fc.assert(
      fc.property(groupArb, (specs) => {
        const withLabels = specs.map(rowOf);
        const stripped = specs.map((s) => rowOf({ ...s, traceId: undefined }));
        expect(slots(stripped)).toEqual(slots(withLabels));
      }),
      { numRuns: 500 },
    );
  });
});

describe('the one property the tuple deliberately does not have (ADR-005 d2)', () => {
  it('does not preserve which raw payload sits under which sentinel when two tuples tie', () => {
    // Two real value moves in one tx with identical (from, to, value), distinguishable only
    // by the provider's label. They tie, and the tie falls to arrival order — so a re-fetch
    // serving them the other way round swaps which `raw` sits under which sentinel.
    //
    // Pinned rather than left implicit, because this is the cost ADR-005 d2 accepts and a
    // future reader "fixing" it would be reintroducing the label as a rank source. Nothing is
    // lost by it: the slots are the same two slots either way, so ON CONFLICT DO NOTHING
    // still matches and no value movement is dropped or duplicated. It is harmless only
    // because `chain_events.raw` has no readers — a fact about today's consumers, which is
    // why it is written down here and in the ADR instead of being assumed away.
    const base: RawInternalTx = {
      blockNumber: '19000010',
      timeStamp: '1700001000',
      hash: HASH,
      from: '0xaa00000000000000000000000000000000000001',
      to: '0xbb00000000000000000000000000000000000002',
      value: '400',
      isError: '0',
    };
    const a: RawInternalTx = { ...base, traceId: '0' };
    const b: RawInternalTx = { ...base, traceId: '1' };
    const pairing = (evs: NormalizedEvent[]): [string | undefined, number][] =>
      evs.map((e) => [(e.raw as RawInternalTx).traceId, e.logIndex]);

    const fwd = normalize({ internal: { items: [a, b] } }, CTX);
    const rev = normalize({ internal: { items: [b, a] } }, CTX);

    expect(pairing(fwd)).toEqual([['0', -1000], ['1', -1001]]);
    expect(pairing(rev)).toEqual([['1', -1000], ['0', -1001]]);
    // There is deliberately no assertion here that the two runs emit the same SET of
    // sentinels, although that is the reason the swap is harmless. It would be unfalsifiable
    // for exactly the reason the header gives: a k-row group emits {-1000 … -(999+k)} under
    // every comparator, so both sides are `{-1000, -1001}` no matter what the code does. An
    // earlier draft of this file condemned that shape at the top and then wrote it at the
    // bottom. The claim belongs in prose (and in ADR-005 d2), not in an `expect`.
  });
});

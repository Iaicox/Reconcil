/**
 * Hermetic coverage for decision-repo.ts's confirm/reject rowcount guard (C8) — the one
 * branch genuinely unreachable through the normal entry points. In production
 * `decideMatchInTx` only ever runs inside `runWriteTool`'s SERIALIZABLE transaction
 * (recon-confirm-match.ts / recon-reject-match.ts), where a concurrent conflict on the
 * same leg surfaces as a retryable Postgres 40001 long before the leg UPDATE's own
 * `status = 'suggested'` predicate could see 0 matching rows — so the itest suites (real
 * Postgres, single caller per test) can never exercise it either. It's reachable only by
 * a future misuse of the exported `decideMatchInTx` outside that wrapper (plain
 * read-committed), which this test simulates directly with a hand-built fake `Tx`: every
 * `select` in call order returns its canned rows, and the leg `update` returns `[]` (the
 * "another writer already changed this row" outcome under read-committed).
 */
import { describe, expect, it } from 'vitest';

import type { Tx } from '@reconcil/db';
import type { TxContext } from '../src/context.js';
import { decideMatchInTx } from '../src/recon/decision-repo.js';

/** A thenable stub: every property access chains to itself; awaiting resolves to `value`. */
function chainOf(value: unknown): unknown {
  return new Proxy(function chainStub() { /* callable no-op for a chain that invokes itself */ }, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(value);
      if (prop === 'catch' || prop === 'finally') return () => chainOf(value);
      return () => chainOf(value);
    },
  });
}

/**
 * A fake `Tx` whose `.select(...)` calls return canned rows IN CALL ORDER (matching
 * decideMatchInTx's fixed SELECT sequence) and whose `.update(...)` always resolves to
 * `updateReturns` (decideMatchInTx only ever issues one UPDATE before returning or
 * throwing, so a single canned value is enough for every scenario here).
 */
function makeFakeTx(selectRows: unknown[][], updateReturns: unknown[]): Tx {
  let call = 0;
  return {
    select: () => {
      const rows = selectRows[call] ?? [];
      call += 1;
      return chainOf(rows);
    },
    update: () => chainOf(updateReturns),
  } as unknown as Tx;
}

const LEG_SUGGESTED = {
  status: 'suggested', externalRecordId: 'rec-1', chainEventId: 1,
  amountAppliedRaw: 500n, fiatValue: '500.00', priceSnapshotId: null, fxRateId: null,
};
const RECORD_OPEN = { id: 'rec-1', amount: '1000.00', status: 'open', currency: 'EUR' };
const EVENT = { amountRaw: 1000n };
const APPLIED_ZERO = { applied: '0' };

describe('decideMatchInTx — confirm/reject rowcount guard (C8)', () => {
  it('throws INTERNAL when the confirm CAS UPDATE affects 0 rows', async () => {
    const tx = makeFakeTx([[LEG_SUGGESTED], [RECORD_OPEN], [EVENT], [APPLIED_ZERO]], []);
    const ctx: TxContext = { db: tx, tenantId: 'tenant-1' };

    await expect(decideMatchInTx(ctx, { matchId: 'm1', decision: 'confirmed' }))
      .rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('throws INTERNAL when the reject CAS UPDATE affects 0 rows', async () => {
    const tx = makeFakeTx([[LEG_SUGGESTED], [RECORD_OPEN]], []);
    const ctx: TxContext = { db: tx, tenantId: 'tenant-1' };

    await expect(decideMatchInTx(ctx, { matchId: 'm1', decision: 'rejected' }))
      .rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('sanity: the same fixture succeeds when the UPDATE reports the row it changed', async () => {
    const tx = makeFakeTx(
      [[LEG_SUGGESTED], [RECORD_OPEN], [EVENT], [APPLIED_ZERO], [{ fiat: '500.00' }]],
      [{ id: 'm1' }],
    );
    const ctx: TxContext = { db: tx, tenantId: 'tenant-1' };

    const result = await decideMatchInTx(ctx, { matchId: 'm1', decision: 'confirmed' });
    expect(result.status).toBe('confirmed');
    expect(result.recordStatus).toBe('partially_matched'); // 500 applied of 1000.00
  });
});

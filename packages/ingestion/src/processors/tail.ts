import { and, eq } from 'drizzle-orm';
import { ingestionCheckpoints } from '@pet-crypto/db';
import { ingestOnce, type IngestTarget, type ProcessorDeps } from './ingest.js';

/**
 * One tail tick: poll the LIVE checkpoint streams of a chain and advance each up
 * to safeHead. The `status='live'` filter keeps tail and backfill on disjoint
 * status sets (a stream is backfill-driven until it reaches `live`, then tail
 * owns it) and skips paused/error streams.
 *
 * Returns the streams a full page pushed back into `backfilling`: a live tick
 * that spans a >PAGE_LIMIT gap (e.g. a large post-downtime window) flips to
 * `backfilling`, and since the next tick's `status='live'` filter would then
 * exclude it, the host MUST hand each returned target to the backfill queue to
 * drain it back to live — otherwise the stream strands silently.
 *
 * Overlaps are idempotent, not corrupting: a slow tick still running when the
 * next repeatable fires, or a backfilling→live transition racing a final
 * backfill job, both read the same cursor and dedupe via ON CONFLICT DO NOTHING
 * (wasted fetch only). A per-checkpoint SELECT … FOR UPDATE that removes that
 * waste lands with the wallet-tracking slice (ledger_track_wallet).
 */
export async function runTailTick(deps: ProcessorDeps, t: { chainId: number }): Promise<IngestTarget[]> {
  const live = await deps.db
    .select({ address: ingestionCheckpoints.address, stream: ingestionCheckpoints.stream })
    .from(ingestionCheckpoints)
    .where(and(eq(ingestionCheckpoints.chainId, t.chainId), eq(ingestionCheckpoints.status, 'live')));
  const backfilling: IngestTarget[] = [];
  for (const cp of live) {
    const target: IngestTarget = { chainId: t.chainId, address: cp.address, stream: cp.stream };
    const res = await ingestOnce(deps, target);
    if (res.status === 'backfilling') backfilling.push(target);
  }
  return backfilling;
}

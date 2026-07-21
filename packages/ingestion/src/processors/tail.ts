import { and, eq } from 'drizzle-orm';
import { ingestionCheckpoints } from '@pet-crypto/db';
import { ingestOnce, type ProcessorDeps } from './ingest.js';

/**
 * One tail tick: poll the LIVE checkpoint streams of a chain and advance each up
 * to safeHead. A stream is driven by backfill jobs until it reaches `live`,
 * after which the tail owns it — so the `status='live'` filter keeps tail and
 * backfill on disjoint status sets (no steady-state double fetch), and skips
 * paused/error streams too. A brief backfilling→live transition can still let a
 * final backfill job and a tail tick overlap; ON CONFLICT DO NOTHING keeps that
 * correct. A per-checkpoint SELECT … FOR UPDATE that closes even that window
 * lands with the wallet-tracking slice (ledger_track_wallet), when streams are
 * auto-seeded.
 */
export async function runTailTick(deps: ProcessorDeps, t: { chainId: number }): Promise<void> {
  const live = await deps.db
    .select({ address: ingestionCheckpoints.address, stream: ingestionCheckpoints.stream })
    .from(ingestionCheckpoints)
    .where(and(eq(ingestionCheckpoints.chainId, t.chainId), eq(ingestionCheckpoints.status, 'live')));
  for (const cp of live) {
    await ingestOnce(deps, { chainId: t.chainId, address: cp.address, stream: cp.stream });
  }
}

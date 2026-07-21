import { eq } from 'drizzle-orm';
import { ingestionCheckpoints } from '@pet-crypto/db';
import { ingestOnce, type ProcessorDeps } from './ingest.js';

/**
 * One tail tick: poll every checkpoint stream of a chain, advancing each up to
 * safeHead. There is deliberately no status filter yet — ingestOnce's
 * `fromBlock > safe` fast-path turns an already-caught-up stream into a cheap
 * no-op. NOTE: nothing here or in the host currently serializes a tail tick
 * against a concurrent backfill job for the same (chain, address, stream) —
 * both can fetch the window and commitPage; ON CONFLICT DO NOTHING keeps that
 * correct but doubles provider work. A `status='live'` filter here plus a
 * per-checkpoint SELECT … FOR UPDATE land with the wallet-tracking slice
 * (ledger_track_wallet), when streams are auto-seeded and the race matters.
 */
export async function runTailTick(deps: ProcessorDeps, t: { chainId: number }): Promise<void> {
  const streams = await deps.db
    .select({ address: ingestionCheckpoints.address, stream: ingestionCheckpoints.stream })
    .from(ingestionCheckpoints)
    .where(eq(ingestionCheckpoints.chainId, t.chainId));
  for (const cp of streams) {
    await ingestOnce(deps, { chainId: t.chainId, address: cp.address, stream: cp.stream });
  }
}

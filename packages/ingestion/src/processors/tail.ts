import { eq } from 'drizzle-orm';
import { ingestionCheckpoints } from '@pet-crypto/db';
import { ingestOnce, type ProcessorDeps } from './ingest.js';

/** One tail tick: advance every live stream of a chain up to safeHead. */
export async function runTailTick(deps: ProcessorDeps, t: { chainId: number }): Promise<void> {
  const live = await deps.db
    .select({ address: ingestionCheckpoints.address, stream: ingestionCheckpoints.stream })
    .from(ingestionCheckpoints)
    .where(eq(ingestionCheckpoints.chainId, t.chainId));
  for (const cp of live) {
    // Re-read status per stream inside ingestOnce; tail only polls already-live streams.
    await ingestOnce(deps, { chainId: t.chainId, address: cp.address, stream: cp.stream });
  }
}

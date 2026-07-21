import { eq } from 'drizzle-orm';
import { ingestionCheckpoints } from '@pet-crypto/db';
import { ingestOnce, type ProcessorDeps } from './ingest.js';

/**
 * One tail tick: poll every checkpoint stream of a chain, advancing each up to
 * safeHead. There is deliberately no status filter — ingestOnce's
 * `fromBlock > safe` fast-path turns an already-caught-up stream into a cheap
 * no-op, so filtering to status='live' is a deferred optimization. Serializing
 * tail vs. backfill on a single checkpoint is the worker host's job (BullMQ),
 * out of scope for this pure processor.
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

/**
 * One backfill job (H15b): run a page, then re-enqueue the next one — but ONLY
 * when the checkpoint's `last_processed_block` actually advanced while the
 * page is still reporting `backfilling`. `main.ts`'s BullMQ processor
 * re-enqueues `job.data` unchanged; `IngestTarget` carries no cursor, so
 * progress depends entirely on `ingestOnce` persisting a new checkpoint value.
 * If some path ever reports `backfilling` without the checkpoint moving —
 * whether that is today's bug or a future change to ingestion internals (e.g.
 * skip-committing a regressed cursor and reporting the stored status honestly)
 * — re-enqueuing the identical payload loops forever. `attempts: 8` only
 * bounds retries of ONE job, not this chain.
 *
 * INVARIANT: re-enqueue iff `status === 'backfilling' AND after > before`,
 * where `before`/`after` are read from the checkpoint itself (`before` via an
 * explicit read, `after` from the page result), never inferred from
 * `ingestOnce`'s internal reasoning. Violating this throws instead — BullMQ's
 * own retry/DLQ then surfaces the stall for a human, rather than the queue
 * spinning silently.
 */
import type { BackfillTarget, IngestResult } from '@reconcil/ingestion';
import type { JobsOptions } from 'bullmq';

import { dlqJobOptions } from './queues.js';

export interface BackfillPageAdd {
  add(name: 'page', data: BackfillTarget, opts: JobsOptions): Promise<unknown>;
}

export interface BackfillJobDeps {
  runPage(target: BackfillTarget): Promise<IngestResult>;
  /** The checkpoint's `last_processed_block` before this page runs; `undefined`
   *  if no checkpoint row exists (mirrors `ingestOnce`'s own precondition —
   *  it throws in that case too, so this path is defensive, not load-bearing). */
  getCheckpointBlock(target: BackfillTarget): Promise<number | undefined>;
}

export async function runBackfillJob(
  deps: BackfillJobDeps,
  target: BackfillTarget,
  queue: BackfillPageAdd,
): Promise<IngestResult> {
  const before = await deps.getCheckpointBlock(target);
  const res = await deps.runPage(target);
  if (res.status !== 'backfilling') return res;

  if (before === undefined || res.lastProcessedBlock <= before) {
    throw new Error(
      `backfill stalled: checkpoint did not advance (chain ${String(target.chainId)}, ` +
        `stream ${target.stream}, before block ${before === undefined ? 'none' : String(before)}, ` +
        `after block ${String(res.lastProcessedBlock)})`,
    );
  }
  await queue.add('page', target, dlqJobOptions);
  return res;
}

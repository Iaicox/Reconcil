/**
 * Onboarding scanner (ADR-008). `ledger_track_wallet` writes `queued`
 * checkpoints but cannot enqueue (it must not import ingestion/BullMQ — the MCP
 * boundary); this closes the loop: scan queued checkpoints and enqueue a backfill
 * page per (chain, address, stream), deduped by the shared deterministic job id
 * (`backfillJobId`) so repeated scans and the id the tool returned to the caller
 * line up. Runs as a repeatable worker tick in main.ts; the first `commitPage`
 * flips a checkpoint off the queued set, so this self-empties.
 */
import { backfillJobId } from '@pet-crypto/core';
import type { Db } from '@pet-crypto/db';
import { listQueuedCheckpoints, type BackfillTarget } from '@pet-crypto/ingestion';
import type { JobsOptions } from 'bullmq';

import { jobOptions } from './queues.js';

/** The slice of BullMQ's Queue the scanner needs — one add per backfill target. */
export interface BackfillEnqueuer {
  add(name: 'page', data: BackfillTarget, opts: JobsOptions): Promise<unknown>;
}

export async function enqueueBackfills(targets: BackfillTarget[], queue: BackfillEnqueuer): Promise<void> {
  for (const t of targets) {
    await queue.add('page', t, { ...jobOptions, jobId: backfillJobId(t.chainId, t.address, t.stream) });
  }
}

/** Scan queued checkpoints and enqueue their backfill pages; returns the count. */
export async function enqueueQueuedBackfills(db: Db, queue: BackfillEnqueuer): Promise<number> {
  const targets = await listQueuedCheckpoints(db);
  await enqueueBackfills(targets, queue);
  return targets.length;
}

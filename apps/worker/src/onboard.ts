/**
 * Onboarding scanner (ADR-008). `ledger_track_wallet` writes `queued`
 * checkpoints but cannot enqueue (it must not import ingestion/BullMQ — the MCP
 * boundary); this closes the loop: scan queued checkpoints and enqueue a backfill
 * page per (chain, address, stream), deduped by the shared deterministic job id
 * (`backfillJobId`) so repeated scans and the id the tool returned to the caller
 * line up. Runs as a repeatable worker tick in main.ts; the first `commitPage`
 * flips a checkpoint off the queued set, so this self-empties.
 *
 * Retained-job wedge (FIXED here; the caveat this docstring used to carry).
 * BullMQ dedups `add` against ANY job still holding the id, including one that has
 * already finished — and both retention policies keep finished jobs around:
 * `removeOnFail: false` (the ADR-008 DLQ) and `removeOnComplete: 1000`. Two ways a
 * checkpoint then sits at `queued` with nothing able to move it:
 *
 *   - the page-1 backfill exhausted its attempts, so `commitPage` never ran; the
 *     failed job is retained by design, and every later scan's re-add is deduped
 *     against it. Nothing flips the checkpoint to `error` either, so `ledger_status`
 *     does not surface it.
 *   - the job *succeeded* without advancing anything: `ingestOnce`'s H7 branch skips
 *     the commit when the safe head is at or below the cursor (a fresh chain where
 *     `head < finalityDepth`, or a stale head from a load-balanced node) and returns
 *     the checkpoint's stored status verbatim — still `queued`. The completed job is
 *     then retained for the next 1000 completions, which on a quiet deployment is
 *     indefinitely.
 *
 * So a FINISHED job under the id is cleared before re-adding. A job that is waiting,
 * active or delayed is left alone — deduping against work that can still make progress
 * is the whole point of the deterministic id. Continuation pages use auto-ids, so only
 * the id-carrying first job of each kind could wedge this way.
 */
import { anchorJobId, backfillJobId, probeJobId } from '@reconcil/core';
import type { Db } from '@reconcil/db';
import {
  listAnchoringCheckpoints, listProbeTargets, listQueuedCheckpoints,
  type AnchorTarget, type BackfillTarget,
} from '@reconcil/ingestion';
import type { JobsOptions } from 'bullmq';

import { dlqJobOptions } from './queues.js';

/** The slice of a retained BullMQ Job the scanner needs to decide whether it is stuck. */
export interface RetainedJob {
  isCompleted(): Promise<boolean>;
  isFailed(): Promise<boolean>;
  remove(): Promise<unknown>;
}

/** Lookup half of BullMQ's Queue: finds a job still holding a deterministic id. */
export interface RetainedJobLookup {
  getJob(id: string): Promise<RetainedJob | undefined | null>;
}

/** The slice of BullMQ's Queue the scanner needs — one add per backfill target. */
export interface BackfillEnqueuer extends RetainedJobLookup {
  add(name: 'page', data: BackfillTarget, opts: JobsOptions): Promise<unknown>;
}
export interface AnchorEnqueuer extends RetainedJobLookup {
  add(name: 'anchor', data: AnchorTarget, opts: JobsOptions): Promise<unknown>;
}
export interface ProbeTargetData { chainId: number; address: string; }
export interface ProbeEnqueuer extends RetainedJobLookup {
  add(name: 'probe', data: ProbeTargetData, opts: JobsOptions): Promise<unknown>;
}

/**
 * Drop a FINISHED job holding `jobId`, so the re-add below is not silently deduped
 * against work that can no longer make progress (see the retained-job wedge above).
 * Waiting/active/delayed jobs are left alone — that dedup is the point of the id.
 *
 * Best-effort: a job that disappears between the lookup and the remove (its retention
 * window aged out, or another scanner got there first) is exactly the state we wanted,
 * so a failure here must not abort the scan for every other target.
 */
async function clearFinishedJob(queue: RetainedJobLookup, jobId: string): Promise<void> {
  try {
    const existing = await queue.getJob(jobId);
    if (!existing) return;
    if ((await existing.isCompleted()) || (await existing.isFailed())) await existing.remove();
  } catch {
    // Nothing to do: the next scan tries again.
  }
}

export async function enqueueBackfills(targets: BackfillTarget[], queue: BackfillEnqueuer): Promise<void> {
  for (const t of targets) {
    const jobId = backfillJobId(t.chainId, t.address, t.stream);
    await clearFinishedJob(queue, jobId);
    await queue.add('page', t, { ...dlqJobOptions, jobId });
  }
}

export async function enqueueAnchors(targets: AnchorTarget[], queue: AnchorEnqueuer): Promise<void> {
  for (const t of targets) {
    const jobId = anchorJobId(t.chainId, t.address, t.stream);
    await clearFinishedJob(queue, jobId);
    await queue.add('anchor', t, { ...dlqJobOptions, jobId });
  }
}

export async function enqueueProbes(targets: ProbeTargetData[], queue: ProbeEnqueuer): Promise<void> {
  for (const t of targets) {
    const jobId = probeJobId(t.chainId, t.address);
    await clearFinishedJob(queue, jobId);
    await queue.add('probe', t, { ...dlqJobOptions, jobId });
  }
}

/** Scan queued checkpoints and enqueue their backfill pages; returns the count. */
export async function enqueueQueuedBackfills(db: Db, queue: BackfillEnqueuer): Promise<number> {
  const targets = await listQueuedCheckpoints(db);
  await enqueueBackfills(targets, queue);
  return targets.length;
}

/** The queues the onboarding tick fans work out to (ADR-008). */
export interface OnboardQueues {
  backfill: BackfillEnqueuer;
  anchor: AnchorEnqueuer;
  probe: ProbeEnqueuer;
}

/**
 * One onboarding scan: fan DB-driven work out to the queues. Backfill (`queued`
 * full-history), anchor (`anchoring` opening_balance baseline), and probe
 * (`queued` wallets with no tx-count hint). All idempotent via deterministic job
 * ids, so re-scans are cheap and each set self-empties as its jobs run.
 */
export async function runOnboardScan(db: Db, q: OnboardQueues): Promise<void> {
  await enqueueQueuedBackfills(db, q.backfill);
  await enqueueAnchors(await listAnchoringCheckpoints(db), q.anchor);
  await enqueueProbes(await listProbeTargets(db), q.probe);
}

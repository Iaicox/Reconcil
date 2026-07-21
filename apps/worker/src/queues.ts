/**
 * Queue topology (ADR-008 §1-2): tail (one repeatable tick per chain) and
 * backfill (one page window per target) are SEPARATE queues, each with its own
 * worker and concurrency cap. That isolation — not BullMQ job priority, which
 * only orders jobs within a single queue — is what keeps live ticks from
 * starving behind a long backfill. Retry: exponential 1 min → 1 h cap, 8
 * attempts, then DLQ (removeOnFail: false keeps the failed job for inspection).
 */
import { Redis } from 'ioredis';
import type { JobsOptions } from 'bullmq';

export const TAIL_QUEUE = 'tail';
export const BACKFILL_QUEUE = 'backfill';

// BullMQ requires maxRetriesPerRequest: null on the connection it owns.
export function makeConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

// Custom backoff so the exponential ramp is capped at 1 h (ADR-008 §2).
export function backoffStrategy(attemptsMade: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attemptsMade - 1), 3_600_000);
}

// Shared by both queues — identical today. Re-split into per-queue policies when
// one needs to diverge (anchored windows, per-queue rate limits in later slices).
export const jobOptions: JobsOptions = {
  attempts: 8,
  backoff: { type: 'custom' },
  removeOnComplete: 1000,
  removeOnFail: false,
};

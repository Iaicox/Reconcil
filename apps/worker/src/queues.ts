/**
 * Queue topology (ADR-008 §1-2): tail (high priority, one repeatable tick per
 * chain) beats backfill (low priority, one page window per target). Retry:
 * exponential 1 min → 1 h cap, 8 attempts, then DLQ (removeOnFail: false keeps
 * the failed job for inspection).
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

export const backfillJobOptions: JobsOptions = {
  attempts: 8,
  backoff: { type: 'custom' },
  priority: 10, // lower number = higher priority; tail uses 1
  removeOnComplete: 1000,
  removeOnFail: false,
};

export const tailJobOptions: JobsOptions = {
  attempts: 8,
  backoff: { type: 'custom' },
  priority: 1,
  removeOnComplete: 1000,
  removeOnFail: false,
};

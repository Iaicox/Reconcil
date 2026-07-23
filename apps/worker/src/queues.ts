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
export const PRICES_QUEUE = 'prices';
export const ONBOARD_QUEUE = 'onboard';
// Anchored-window baseline (ADR-008): one opening_balance write per (chain,
// address, stream), then the anchor worker hands off to the backfill queue.
export const ANCHOR_QUEUE = 'anchor';
// >50k probe (ADR-008 Q5): one cheap tx-count estimate per wallet at onboarding.
export const PROBE_QUEUE = 'probe';

// Onboarding scanner: turn `queued` checkpoints (written by ledger_track_wallet)
// into backfill jobs. A short tick so a freshly tracked wallet starts backfilling
// promptly; idempotent (backfill jobId dedup) so re-scans are cheap.
export const ONBOARD_TICK_EVERY_MS = 15_000;

// Prices are daily UTC closes (ADR-007) — one fill tick per day is enough; it
// backfills every not-yet-priced (token, date) each run, so a missed tick self-heals.
export const PRICE_TICK_EVERY_MS = 24 * 60 * 60 * 1000;

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

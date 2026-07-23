/**
 * Worker host (ADR-008, 00-overview §2). Boot order: load env → migrate → db →
 * redis → queues + workers → repeatable tail per chain. All provider I/O and
 * retries live here; the domain logic runs in @pet-crypto/ingestion. Errors are
 * logged via serializeError — err.cause (hostile) never reaches the log (ADR-011).
 */
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import { chains, createLogger, serializeError } from '@pet-crypto/core';
import { createDb, runMigrations } from '@pet-crypto/db';
import {
  buildProviderBundle, realFetchJson, runAnchor, runBackfillPage, runProbe, runTailTick, type ProcessorDeps,
} from '@pet-crypto/ingestion';
import {
  buildPriceProviderBundle, realFetchJson as realPriceFetchJson, throttled, runPriceFill,
} from '@pet-crypto/pricing';
import { loadConfig } from './config.js';
import { enqueueBackfills, runOnboardScan } from './onboard.js';
import {
  ANCHOR_QUEUE, BACKFILL_QUEUE, ONBOARD_QUEUE, ONBOARD_TICK_EVERY_MS, PROBE_QUEUE,
  PRICES_QUEUE, PRICE_TICK_EVERY_MS, TAIL_QUEUE,
  backoffStrategy, jobOptions, makeConnection,
} from './queues.js';

const logger = createLogger({ name: 'worker' });

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  await runMigrations(pool);
  const db = createDb(pool);
  logger.info('migrations applied');

  const connection = makeConnection(cfg.REDIS_URL);
  // Without an 'error' listener Node throws on the first Redis error and crashes
  // past the shutdown handlers, printing the raw Error (hostile cause) to stderr
  // (ADR-011). Route it through serializeError instead.
  connection.on('error', (err) => { logger.error('redis connection error', { err: serializeError(err) }); });
  const deps: ProcessorDeps = {
    db,
    bundleFor: (chainId) =>
      buildProviderBundle({ chainId, env: process.env, fetchJson: realFetchJson() }),
    logger,
  };

  const backfillQueue = new Queue(BACKFILL_QUEUE, { connection });
  const tailQueue = new Queue(TAIL_QUEUE, { connection });
  const pricesQueue = new Queue(PRICES_QUEUE, { connection });
  const onboardQueue = new Queue(ONBOARD_QUEUE, { connection });
  const anchorQueue = new Queue(ANCHOR_QUEUE, { connection });
  const probeQueue = new Queue(PROBE_QUEUE, { connection });

  // Prices (ADR-007): daily fill of every not-yet-priced (token, date) + ECB FX,
  // idempotent so a re-run/missed tick self-heals. Throttled so a large first fill
  // doesn't burst public price endpoints into 429s.
  const priceBundle = buildPriceProviderBundle({
    env: process.env, fetchJson: throttled(realPriceFetchJson(), 250),
  });
  const pricesWorker = new Worker(
    PRICES_QUEUE,
    async () => runPriceFill({ db, bundle: priceBundle, logger }),
    { connection, concurrency: 1, settings: { backoffStrategy } },
  );

  const backfillWorker = new Worker(
    BACKFILL_QUEUE,
    async (job) => {
      const res = await runBackfillPage(deps, job.data);
      // Full page ⇒ enqueue the next window (ADR-008 §3). res.unseenContracts (the
      // erc20 contracts this page referenced) is unused until the token-resolve
      // queue lands — it will consume it then.
      if (res.status === 'backfilling') await backfillQueue.add('page', job.data, jobOptions);
      return res;
    },
    { connection, concurrency: 5, settings: { backoffStrategy } },
  );

  const tailWorker = new Worker(
    TAIL_QUEUE,
    async (job) => {
      // A live tick spanning a >PAGE_LIMIT gap (e.g. a large post-downtime
      // window) flips a stream to 'backfilling'; the status='live' filter would
      // then exclude it from future ticks, so drain it via the backfill queue
      // (ADR-008 §3). Without this the stream strands silently.
      const backfilling = await runTailTick(deps, job.data);
      for (const target of backfilling) await backfillQueue.add('page', target, jobOptions);
    },
    { connection, concurrency: chains.length, settings: { backoffStrategy } },
  );

  // Anchored-window baseline (ADR-008): write the opening_balance at the anchor,
  // then hand the stream to the backfill queue (now 'backfilling') so history
  // continues forward from the anchor — the same drain the tail worker uses.
  const anchorWorker = new Worker(
    ANCHOR_QUEUE,
    async (job) => {
      const res = await runAnchor(deps, job.data);
      // Deterministic backfillJobId (via the shared scanner helper) so an anchor-job
      // retry re-enqueues the SAME page-1 rather than a duplicate — no collision, the
      // checkpoint is 'backfilling' now so neither scanner nor tail produces this id.
      await enqueueBackfills([{ chainId: job.data.chainId, address: job.data.address, stream: job.data.stream }], backfillQueue);
      return res;
    },
    { connection, concurrency: 2, settings: { backoffStrategy } },
  );

  // >50k probe (ADR-008 Q5): a cheap tx-count estimate stored on the wallet's
  // native checkpoint; ledger_status reads it to surface suggests_anchored.
  const probeWorker = new Worker(
    PROBE_QUEUE,
    async (job) => runProbe(deps, job.data),
    { connection, concurrency: 2, settings: { backoffStrategy } },
  );

  // Onboarding scanner (ADR-008): fan queued/anchoring/unprobed checkpoints out to
  // the backfill, anchor, and probe queues. The read + enqueue live in
  // @pet-crypto/ingestion + onboard.ts; this is the tick host.
  const onboardWorker = new Worker(
    ONBOARD_QUEUE,
    async () => { await runOnboardScan(db, { backfill: backfillQueue, anchor: anchorQueue, probe: probeQueue }); },
    { connection, concurrency: 1, settings: { backoffStrategy } },
  );

  for (const q of [backfillQueue, tailQueue, pricesQueue, onboardQueue, anchorQueue, probeQueue]) {
    q.on('error', (err) => { logger.error('queue error', { queue: q.name, err: serializeError(err) }); });
  }
  for (const w of [backfillWorker, tailWorker, pricesWorker, onboardWorker, anchorWorker, probeWorker]) {
    w.on('error', (err) => { logger.error('worker error', { queue: w.name, err: serializeError(err) }); });
    w.on('failed', (job, err) => { logger.error('job failed', { queue: w.name, jobId: job?.id, err: serializeError(err) }); });
  }

  // Repeatable tail tick per chain (Redis loss recovers on boot — ADR-008).
  for (const chain of chains) {
    await tailQueue.add('tick', { chainId: chain.chainId },
      { ...jobOptions, repeat: { every: chain.pollIntervalSec * 1000 }, jobId: `tail-${String(chain.chainId)}` });
  }
  // Daily price fill (ADR-007) — one repeatable tick, idempotent per run.
  await pricesQueue.add('fill', {}, { ...jobOptions, repeat: { every: PRICE_TICK_EVERY_MS }, jobId: 'prices-fill' });
  // Onboarding scan — one repeatable tick; idempotent (backfill jobId dedup).
  await onboardQueue.add('scan', {}, { ...jobOptions, repeat: { every: ONBOARD_TICK_EVERY_MS }, jobId: 'onboard-scan' });
  logger.info('worker up', { chains: chains.map((c) => c.chainId) });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // ignore a second SIGINT/SIGTERM
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // Force exit if a close() hangs (a wedged Redis/pg socket) so the process
    // never lingers past the orchestrator's grace period.
    const force = setTimeout(() => { logger.error('shutdown timed out; forcing exit'); process.exit(1); }, 10_000);
    force.unref();
    try {
      await backfillWorker.close();
      await tailWorker.close();
      await pricesWorker.close();
      await onboardWorker.close();
      await anchorWorker.close();
      await probeWorker.close();
      await backfillQueue.close();
      await tailQueue.close();
      await pricesQueue.close();
      await onboardQueue.close();
      await anchorQueue.close();
      await probeQueue.close();
      await connection.quit();
      await pool.end();
      process.exit(0);
    } catch (err) {
      logger.error('shutdown error', { err: serializeError(err) });
      process.exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void shutdown(signal); });
  }
}

main().catch((err: unknown) => {
  logger.error('worker boot failed', { err: serializeError(err) });
  process.exit(1);
});

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
  buildProviderBundle, realFetchJson, runBackfillPage, runTailTick, type ProcessorDeps,
} from '@pet-crypto/ingestion';
import { loadConfig } from './config.js';
import {
  BACKFILL_QUEUE, TAIL_QUEUE, backoffStrategy, jobOptions, makeConnection,
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

  for (const q of [backfillQueue, tailQueue]) {
    q.on('error', (err) => { logger.error('queue error', { queue: q.name, err: serializeError(err) }); });
  }
  for (const w of [backfillWorker, tailWorker]) {
    w.on('error', (err) => { logger.error('worker error', { queue: w.name, err: serializeError(err) }); });
    w.on('failed', (job, err) => { logger.error('job failed', { queue: w.name, jobId: job?.id, err: serializeError(err) }); });
  }

  // Repeatable tail tick per chain (Redis loss recovers on boot — ADR-008).
  for (const chain of chains) {
    await tailQueue.add('tick', { chainId: chain.chainId },
      { ...jobOptions, repeat: { every: chain.pollIntervalSec * 1000 }, jobId: `tail-${String(chain.chainId)}` });
  }
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
      await backfillQueue.close();
      await tailQueue.close();
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

/**
 * Dev-only wallet seeding. There is no ledger_track_wallet MCP tool yet (server
 * slice), so this registers the queued checkpoints and enqueues the initial
 * backfill for both streams. Importable as seedWallet(db, queue, chain, addr),
 * and runnable directly against the compose stack for a smoke:
 *   pnpm --filter @pet-crypto/worker exec tsx src/seed.ts <chainId> <address>
 * (DATABASE_URL / REDIS_URL from the environment). Not wired into worker boot or CI.
 */
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { createLogger, serializeError } from '@pet-crypto/core';
import { createDb, type Db } from '@pet-crypto/db';
import { seedCheckpoint, type BackfillTarget } from '@pet-crypto/ingestion';
import { loadConfig } from './config.js';
import { BACKFILL_QUEUE, jobOptions, makeConnection } from './queues.js';

export async function seedWallet(db: Db, backfillQueue: Queue, chainId: number, address: string): Promise<void> {
  const addr = address.toLowerCase();
  for (const stream of ['native', 'erc20'] as const) {
    await seedCheckpoint(db, chainId, addr, stream);
    const target: BackfillTarget = { chainId, address: addr, stream };
    await backfillQueue.add('page', target, jobOptions);
  }
}

async function runCli(argv: string[]): Promise<void> {
  const logger = createLogger({ name: 'seed' });
  const [chainArg, address] = argv;
  const chainId = Number(chainArg);
  if (chainArg === undefined || address === undefined || !Number.isInteger(chainId)) {
    logger.error('usage: tsx src/seed.ts <chainId> <address>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  const connection = makeConnection(cfg.REDIS_URL);
  const backfillQueue = new Queue(BACKFILL_QUEUE, { connection });
  try {
    await seedWallet(createDb(pool), backfillQueue, chainId, address);
    logger.info('seeded wallet', { chainId, address: address.toLowerCase() });
  } finally {
    await backfillQueue.close();
    await connection.quit();
    await pool.end();
  }
}

// Runs only when invoked directly (tsx src/seed.ts …); inert when imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    createLogger({ name: 'seed' }).error('seed failed', { err: serializeError(err) });
    process.exit(1);
  });
}

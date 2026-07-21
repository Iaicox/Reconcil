/**
 * Dev-only: register a wallet for ingestion. No ledger_track_wallet MCP tool yet
 * (server slice), so this seeds the queued checkpoints and enqueues the initial
 * backfill for both streams. Used by `docker compose` smoke runs, not in CI.
 */
import { seedCheckpoint, type BackfillTarget } from '@pet-crypto/ingestion';
import type { Db } from '@pet-crypto/db';
import type { Queue } from 'bullmq';
import { backfillJobOptions } from './queues.js';

export async function seedWallet(db: Db, backfillQueue: Queue, chainId: number, address: string): Promise<void> {
  const addr = address.toLowerCase();
  for (const stream of ['native', 'erc20'] as const) {
    await seedCheckpoint(db, chainId, addr, stream);
    const target: BackfillTarget = { chainId, address: addr, stream };
    await backfillQueue.add('page', target, backfillJobOptions);
  }
}

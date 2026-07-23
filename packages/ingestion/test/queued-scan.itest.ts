import { createLogger } from '@pet-crypto/core';
import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runBackfillPage } from '../src/processors/backfill.js';
import type { ProcessorDeps } from '../src/processors/ingest.js';
import type { ProviderBundle } from '../src/providers/provider-factory.js';
import type { RawNativeTx } from '../src/types.js';
import { listQueuedCheckpoints, seedCheckpoint } from '../src/write/checkpoint-repo.js';

const ADDR = '0xaaa0000000000000000000000000000000000001';
const DEST = '0xbbb0000000000000000000000000000000000002';

const nativeTx = (block: number): RawNativeTx => ({
  blockNumber: String(block), timeStamp: '1700000000', hash: `0xtx${String(block)}`,
  from: ADDR, to: DEST, value: '1000', gasUsed: '21000', gasPrice: '2', isError: '0',
});
// Short native page (1 tx then empty) ⇒ backfill flips the checkpoint straight to 'live'.
const bundle: ProviderBundle = {
  indexer: {
    kind: 'etherscan-v2',
    getHead: async () => 1_000_000n,
    getNativeTxs: async (q) => ({ items: Number(q.fromBlock) <= 100 ? [nativeTx(100)] : [] }),
    getErc20Transfers: async () => ({ items: [] }),
  },
  getReceipts: async () => [],
};

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => { await pool.query('TRUNCATE ingestion_checkpoints, chain_events, tokens RESTART IDENTITY CASCADE'); });

describe('listQueuedCheckpoints', () => {
  it('returns only queued checkpoints, ordered deterministically', async () => {
    await seedCheckpoint(db, 1, ADDR, 'native');
    await seedCheckpoint(db, 1, ADDR, 'erc20');
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status) VALUES (8453, $1, 'native', 'live')`,
      [ADDR],
    );

    expect(await listQueuedCheckpoints(db)).toEqual([
      { chainId: 1, address: ADDR, stream: 'erc20' },
      { chainId: 1, address: ADDR, stream: 'native' },
    ]);
  });

  it('returns [] when nothing is queued', async () => {
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status) VALUES (1, $1, 'native', 'live')`,
      [ADDR],
    );
    expect(await listQueuedCheckpoints(db)).toEqual([]);
  });

  it('the onboarding loop self-empties: queued → backfill page → no longer queued', async () => {
    await seedCheckpoint(db, 1, ADDR, 'native'); // status 'queued'
    const [target] = await listQueuedCheckpoints(db);
    expect(target).toEqual({ chainId: 1, address: ADDR, stream: 'native' });

    const deps: ProcessorDeps = { db, bundleFor: () => bundle, logger: createLogger({ name: 'test' }) };
    await runBackfillPage(deps, target!);

    // Backfill flipped the checkpoint off 'queued', so the next scan won't re-enqueue it.
    expect(await listQueuedCheckpoints(db)).toEqual([]);
  });
});

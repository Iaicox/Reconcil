import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { listQueuedCheckpoints, seedCheckpoint } from '../src/write/checkpoint-repo.js';

const ADDR = '0xaaa0000000000000000000000000000000000001';

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

beforeEach(async () => { await pool.query('TRUNCATE ingestion_checkpoints RESTART IDENTITY CASCADE'); });

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
});

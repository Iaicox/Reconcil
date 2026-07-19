import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type Db } from '@pet-crypto/db';
import { runMigrations } from '@pet-crypto/db';
import { chainById } from '@pet-crypto/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../src/types.js';
import { commitPage, getCheckpoint, seedCheckpoint } from '../src/write/checkpoint-repo.js';
import { insertEventRows } from '../src/write/event-writer.js';
import { toChainEventRow } from '../src/write/event-writer.js';

const chain = chainById(1);
const ADDR = '0xaaa0000000000000000000000000000000000001';

const nativeEvent = (block: number, logIndex: number): NormalizedEvent => ({
  chainId: 1, txHash: `0xtx${block}`, logIndex, eventKind: logIndex === -2 ? 'gas_fee' : 'native_transfer',
  token: { kind: 'native' }, fromAddr: ADDR, toAddr: '0xbbb0000000000000000000000000000000000002',
  amountRaw: 1000n, blockNumber: BigInt(block), blockTime: new Date('2024-01-01T00:00:00Z'),
  provider: 'etherscan-v2', txFrom: ADDR, txTo: '0xbbb0000000000000000000000000000000000002', raw: {},
});

describe('write layer', () => {
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

  it('commitPage upserts the native token, inserts events, advances the cursor', async () => {
    await seedCheckpoint(db, 1, ADDR, 'native');
    const inserted = await commitPage(db, { chainId: 1, address: ADDR, stream: 'native' },
      [nativeEvent(100, -1), nativeEvent(100, -2)], { lastProcessedBlock: 100, status: 'live' }, chain);
    expect(inserted).toBe(2);
    const cp = await getCheckpoint(db, 1, ADDR, 'native');
    expect(cp).toMatchObject({ status: 'live', lastProcessedBlock: 100 });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chain_events');
    expect(rows[0].n).toBe(2);
  });

  it('is idempotent — re-committing the same events inserts nothing new', async () => {
    const again = await commitPage(db, { chainId: 1, address: ADDR, stream: 'native' },
      [nativeEvent(100, -1), nativeEvent(100, -2)], { lastProcessedBlock: 100, status: 'live' }, chain);
    expect(again).toBe(0);
  });

  it('inv.6 — write-chunk size does not change the ledger', async () => {
    await pool.query('TRUNCATE chain_events CASCADE'); // matches FKs chain_events.id; CASCADE required (matches is empty here)
    const events = Array.from({ length: 250 }, (_, i) => nativeEvent(1000 + i, -1));
    // resolve one native token id, build rows once
    const chunkInsert = async (size: number): Promise<string[]> => {
      await pool.query('TRUNCATE chain_events CASCADE'); // matches FKs chain_events.id; CASCADE required (matches is empty here)
      const tid = (await pool.query(`SELECT id FROM tokens WHERE chain_id=1 AND address IS NULL`)).rows[0].id as number;
      const rows = events.map((e) => toChainEventRow(e, tid));
      for (let i = 0; i < rows.length; i += size) await insertEventRows(db, rows.slice(i, i + size));
      const r = await pool.query('SELECT tx_hash FROM chain_events ORDER BY tx_hash');
      return r.rows.map((x) => x.tx_hash as string);
    };
    const a = await chunkInsert(10); const b = await chunkInsert(100); const c = await chunkInsert(1000);
    expect(a).toEqual(b); expect(b).toEqual(c); expect(a.length).toBe(250);
  });
});

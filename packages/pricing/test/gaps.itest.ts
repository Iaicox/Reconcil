import { chainEvents, createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { priceGaps } from '../src/gaps.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let seq = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query('TRUNCATE chain_events, price_snapshots, tokens RESTART IDENTITY CASCADE');
  seq = 0;
});

const EXT = '0x00000000000000000000000000000000000000e1';
const OWNED = '0x00000000000000000000000000000000000000a1';

async function seedToken(id: number): Promise<void> {
  await pool.query(
    `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
     OVERRIDING SYSTEM VALUE VALUES ($1,1,$2,'erc20',18,false,NULL,true,$3)`,
    [id, `0x${id.toString(16).padStart(40, '0')}`, `T${String(id)}`],
  );
}

async function seedEvent(tokenId: number, date: string): Promise<void> {
  seq += 1;
  await db.insert(chainEvents).values({
    chainId: 1, txHash: `0x${seq.toString(16).padStart(64, '0')}`, logIndex: 0, eventKind: 'erc20_transfer',
    tokenId, amountRaw: 1n, fromAddr: EXT, toAddr: OWNED, blockNumber: seq,
    blockTime: new Date(`${date}T12:00:00Z`), txFrom: EXT, txTo: OWNED, provider: 'fixture', raw: {},
  });
}

async function seedSnapshot(tokenId: number, date: string, currency: string, source: string): Promise<void> {
  await pool.query(
    `INSERT INTO price_snapshots (token_id, price_date, currency, price, source) VALUES ($1,$2,$3,1,$4)`,
    [tokenId, date, currency, source],
  );
}

describe('priceGaps — a gap is closed by ANY non-peg snapshot, regardless of currency', () => {
  it('reports a gap when no snapshot exists at all', async () => {
    await seedToken(1);
    await seedEvent(1, '2026-06-01');
    const gaps = await priceGaps(db);
    expect(gaps).toEqual([expect.objectContaining({ tokenId: 1, date: '2026-06-01' })]);
  });

  it('closes the gap on a USD snapshot (baseline, unchanged behavior)', async () => {
    await seedToken(1);
    await seedEvent(1, '2026-06-01');
    await seedSnapshot(1, '2026-06-01', 'USD', 'defillama');
    expect(await priceGaps(db)).toEqual([]);
  });

  // Regression: this used to filter `ps.currency = 'USD'` — a non-USD provider hit would
  // never close the gap, and priceGaps would re-emit (token, date) on every daily tick
  // forever (ON CONFLICT dedupes the re-insert, so it looked like silent no-op progress).
  it('closes the gap on a NON-USD snapshot — a stored price in another currency is still real', async () => {
    await seedToken(1);
    await seedEvent(1, '2026-06-01');
    await seedSnapshot(1, '2026-06-01', 'EUR', 'defillama');
    expect(await priceGaps(db)).toEqual([]);
  });

  it('does NOT close the gap on a peg-source snapshot, in any currency (peg is not a market price)', async () => {
    await seedToken(1);
    await seedEvent(1, '2026-06-01');
    await seedSnapshot(1, '2026-06-01', 'EUR', 'peg');
    const gaps = await priceGaps(db);
    expect(gaps).toEqual([expect.objectContaining({ tokenId: 1, date: '2026-06-01' })]);
  });
});

import { chainEvents, createDb, priceSnapshots, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { materializePegSnapshots } from '../src/snapshot-service.js';

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

async function seedStablecoin(id: number, pegCurrency = 'USD'): Promise<void> {
  await pool.query(
    `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
     OVERRIDING SYSTEM VALUE VALUES ($1,1,$2,'erc20',6,true,$3,true,$4)`,
    [id, `0x${id.toString(16).padStart(40, '0')}`, pegCurrency, `T${String(id)}`],
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

describe('materializePegSnapshots — incremental, correct for backfilled history', () => {
  it('inserts one peg row per (token, date) and is idempotent on an unchanged re-run', async () => {
    await seedStablecoin(1);
    await seedEvent(1, '2026-06-01');
    await seedEvent(1, '2026-06-01'); // same date, second transfer — must still dedup to 1 row

    const first = await materializePegSnapshots(db);
    expect(first).toBe(1);

    const second = await materializePegSnapshots(db);
    expect(second).toBe(0);
  });

  it('does not reprocess already-materialized history — only genuinely new (token, date) rows count', async () => {
    await seedStablecoin(1);
    // A chunk of "old" history already covered by a prior run.
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']) {
      await seedEvent(1, d);
    }
    const firstRun = await materializePegSnapshots(db);
    expect(firstRun).toBe(5);

    // One genuinely new date on top of the already-covered history.
    await seedEvent(1, '2026-01-06');
    const secondRun = await materializePegSnapshots(db);
    expect(secondRun).toBe(1); // only the new date, not a re-count of the other 5
  });

  it('still covers a newly-ingested OLD event after materialization has already advanced past later dates ' +
    '(backfill correctness — the reason this is NOT a block_time/date watermark)', async () => {
    await seedStablecoin(1);
    await seedEvent(1, '2026-06-10');
    const first = await materializePegSnapshots(db);
    expect(first).toBe(1); // peg row for 2026-06-10 exists; "latest materialized date" is now 2026-06-10

    // Simulate a backfill: a wallet's ingestion window widens and picks up an event far
    // OLDER than anything materialized so far. A time-window/high-water-mark predicate
    // keyed on the max already-materialized date would wrongly skip this.
    await seedEvent(1, '2026-01-01');
    const second = await materializePegSnapshots(db);
    expect(second).toBe(1);

    const rows = await db
      .select({ priceDate: priceSnapshots.priceDate })
      .from(priceSnapshots)
      .where(eq(priceSnapshots.tokenId, 1));
    const dates = rows.map((r) => String(r.priceDate)).sort();
    expect(dates).toEqual(['2026-01-01', '2026-06-10']);
  });
});

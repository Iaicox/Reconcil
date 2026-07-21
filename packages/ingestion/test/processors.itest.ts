import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { createLogger } from '@pet-crypto/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderBundle } from '../src/providers/provider-factory.js';
import type { Page, RawNativeTx, RawReceipt } from '../src/types.js';
import { seedCheckpoint } from '../src/write/checkpoint-repo.js';
import { runBackfillPage } from '../src/processors/backfill.js';

const ADDR = '0xaaa0000000000000000000000000000000000001';
const DEST = '0xbbb0000000000000000000000000000000000002';

const nativeTx = (block: number): RawNativeTx => ({
  blockNumber: String(block), timeStamp: '1700000000', hash: `0xtx${block}`,
  from: ADDR, to: DEST, value: '1000', gasUsed: '21000', gasPrice: '2', isError: '0',
});

// One page of 3 txs, then a short page ⇒ backfill flips to live.
const makeBundle = (): ProviderBundle => ({
  indexer: {
    kind: 'etherscan-v2',
    getHead: async () => 1_000_000n,
    getNativeTxs: async (q): Promise<Page<RawNativeTx>> => {
      const start = Number(q.fromBlock);
      return { items: start <= 100 ? [nativeTx(100), nativeTx(101), nativeTx(102)] : [] };
    },
    getErc20Transfers: async () => ({ items: [] }),
  },
  getReceipts: async (): Promise<RawReceipt[]> => [],
});

describe('runBackfillPage', () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let pool: Pool;
  const deps = () => ({ db, bundleFor: () => makeBundle(), logger: createLogger({ name: 'test' }) });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    db = createDb(pool);
  }, 120_000);
  afterAll(async () => { await pool.end(); await container.stop(); });

  const drain = async (): Promise<void> => {
    await seedCheckpoint(db, 1, ADDR, 'native');
    let res = await runBackfillPage(deps(), { chainId: 1, address: ADDR, stream: 'native' });
    while (res.status === 'backfilling') res = await runBackfillPage(deps(), { chainId: 1, address: ADDR, stream: 'native' });
  };

  it('ingests native + gas events and reaches live', async () => {
    await drain();
    const { rows } = await pool.query('SELECT event_kind, count(*)::int AS n FROM chain_events GROUP BY event_kind');
    const byKind = Object.fromEntries(rows.map((r) => [r.event_kind, r.n]));
    expect(byKind.native_transfer).toBe(3);
    expect(byKind.gas_fee).toBe(3);
  });

  it('inv.5 — ingesting the same data twice is byte-identical', async () => {
    const snapshot = async (): Promise<string> =>
      (await pool.query('SELECT tx_hash, log_index, amount_raw FROM chain_events ORDER BY tx_hash, log_index'))
        .rows.map((r) => `${r.tx_hash}:${r.log_index}:${r.amount_raw}`).join('|');
    const first = await snapshot();
    await drain(); // re-run over the same window
    expect(await snapshot()).toBe(first);
  });
});

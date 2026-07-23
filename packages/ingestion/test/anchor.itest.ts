import { createLogger } from '@pet-crypto/core';
import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runAnchor } from '../src/processors/anchor.js';
import { runProbe } from '../src/processors/probe.js';
import type { ProcessorDeps } from '../src/processors/ingest.js';
import type { ProviderBundle } from '../src/providers/provider-factory.js';
import { listAnchoringCheckpoints, listProbeTargets } from '../src/write/checkpoint-repo.js';

const ADDR = '0xaaa0000000000000000000000000000000000001';
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // usdc-ish, verified curated
const ONE_ETH = 1_000_000_000_000_000_000n;

// getBlockByTime → 500 (well below safe head), balances attested by "blockscout".
const bundle: ProviderBundle = {
  indexer: {
    kind: 'blockscout',
    getHead: async () => 1_000_000n,
    getNativeTxs: async () => ({ items: [] }),
    getErc20Transfers: async () => ({ items: [] }),
  },
  getReceipts: async () => [],
  getBlockByTime: async () => 500n,
  getNativeBalanceAt: async () => ({ balance: ONE_ETH, provider: 'blockscout' }),
  getErc20BalanceAt: async () => ({ balance: 2_500_000n, provider: 'blockscout' }),
  estimateTxCount: async () => 75_000,
};
const deps = (db: Db, over: Partial<ProviderBundle> = {}): ProcessorDeps => ({
  db,
  bundleFor: () => ({ ...bundle, ...over }),
  logger: createLogger({ name: 'test' }),
});

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const seedAnchoring = (chainId: number, stream: 'native' | 'erc20', from: string): Promise<unknown> =>
  pool.query(
    `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, anchor_from)
     VALUES ($1, $2, $3, 'anchoring', $4)`,
    [chainId, ADDR, stream, from],
  );

const seedCuratedToken = (): Promise<unknown> =>
  pool.query(
    `INSERT INTO tokens (chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified)
     VALUES (1, $1, 'erc20', 6, true, 'USD', true)`,
    [TOKEN],
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query('TRUNCATE ingestion_checkpoints, chain_events, tokens RESTART IDENTITY CASCADE');
});

describe('runAnchor — native stream', () => {
  it('writes one native opening_balance and flips the checkpoint to backfilling at the anchor', async () => {
    await seedAnchoring(1, 'native', '2024-01-01');

    const res = await runAnchor(deps(db), { chainId: 1, address: ADDR, stream: 'native', anchorFrom: '2024-01-01' });
    expect(res).toEqual({ anchorBlock: 500, inserted: 1 });

    const { rows } = await pool.query(
      `SELECT c.tx_hash, c.log_index, c.event_kind, c.amount_raw, c.from_addr, c.to_addr, c.block_number, c.provider, t.standard
       FROM chain_events c JOIN tokens t ON t.id = c.token_id`,
    );
    expect(rows).toEqual([
      {
        tx_hash: `anchor:${ADDR}:500`,
        log_index: -3,
        event_kind: 'opening_balance',
        amount_raw: ONE_ETH.toString(),
        from_addr: '0x0000000000000000000000000000000000000000',
        to_addr: ADDR,
        block_number: '500',
        provider: 'blockscout',
        standard: 'native',
      },
    ]);

    const cp = await pool.query(
      `SELECT status, anchor_block, last_processed_block FROM ingestion_checkpoints WHERE stream='native'`,
    );
    expect(cp.rows[0]).toEqual({ status: 'backfilling', anchor_block: '500', last_processed_block: '500' });
    // left the anchoring set
    expect(await listAnchoringCheckpoints(db)).toEqual([]);
  });

  it('is idempotent — re-running the same anchor inserts no new events (ADR-005 key)', async () => {
    await seedAnchoring(1, 'native', '2024-01-01');
    await runAnchor(deps(db), { chainId: 1, address: ADDR, stream: 'native', anchorFrom: '2024-01-01' });
    const again = await runAnchor(deps(db), { chainId: 1, address: ADDR, stream: 'native', anchorFrom: '2024-01-01' });
    expect(again.inserted).toBe(0);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM chain_events`);
    expect(rows[0].n).toBe(1);
  });

  it('skips a zero native balance (no baseline event needed)', async () => {
    await seedAnchoring(1, 'native', '2024-01-01');
    const res = await runAnchor(
      deps(db, { getNativeBalanceAt: async () => ({ balance: 0n, provider: 'blockscout' }) }),
      { chainId: 1, address: ADDR, stream: 'native', anchorFrom: '2024-01-01' },
    );
    expect(res.inserted).toBe(0);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM chain_events`);
    expect(rows[0].n).toBe(0);
  });
});

describe('runAnchor — erc20 stream', () => {
  it('writes one opening_balance per curated verified token', async () => {
    await seedCuratedToken();
    await seedAnchoring(1, 'erc20', '2024-01-01');

    const res = await runAnchor(deps(db), { chainId: 1, address: ADDR, stream: 'erc20', anchorFrom: '2024-01-01' });
    expect(res.inserted).toBe(1);

    const { rows } = await pool.query(
      `SELECT c.amount_raw, c.to_addr, t.address FROM chain_events c JOIN tokens t ON t.id = c.token_id`,
    );
    expect(rows).toEqual([{ amount_raw: '2500000', to_addr: ADDR, address: TOKEN }]);
  });
});

describe('runProbe', () => {
  const seedQueued = (stream: 'native' | 'erc20'): Promise<unknown> =>
    pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status) VALUES (1, $1, $2, 'queued')`,
      [ADDR, stream],
    );

  it('stores the estimated tx count on the native stream row and leaves the probe set', async () => {
    await seedQueued('native');
    await seedQueued('erc20');
    // the wallet is an unprobed target before the probe runs
    expect(await listProbeTargets(db)).toEqual([{ chainId: 1, address: ADDR }]);

    const hint = await runProbe(deps(db), { chainId: 1, address: ADDR });
    expect(hint).toBe(75_000);
    const { rows } = await pool.query(
      `SELECT tx_count_hint FROM ingestion_checkpoints WHERE stream='native'`,
    );
    expect(rows[0].tx_count_hint).toBe('75000');
    // hint set ⇒ self-empties, the next scan won't re-probe
    expect(await listProbeTargets(db)).toEqual([]);
  });

  it('degrades quietly when no provider can estimate (hint stays null)', async () => {
    await seedQueued('native');
    const hint = await runProbe(deps(db, { estimateTxCount: async () => undefined }), { chainId: 1, address: ADDR });
    expect(hint).toBeUndefined();
    const { rows } = await pool.query(
      `SELECT tx_count_hint FROM ingestion_checkpoints WHERE stream='native'`,
    );
    expect(rows[0].tx_count_hint).toBeNull();
  });
});

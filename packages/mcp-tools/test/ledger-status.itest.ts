import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ToolError } from '../src/errors.js';
import { ledgerStatus } from '../src/tools/ledger-status.js';
import {
  EXT, OWNED, OWNED2, TENANT, TENANT2, WALLET_OWNED, WALLET_OWNED2,
  eth, makeSeeder, type Seeder,
} from './seed.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let S: Seeder;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
  S = makeSeeder(pool, db);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => { await S.truncate(); });

const ctx: () => ToolContext = () => ({ db, tenantId: TENANT });

describe('ledger_status — coverage/freshness, integrity, warnings, tenancy', () => {
  it('reports per-stream freshness for a live wallet and persists the tool_call (C2)', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
    await S.event({ tokenId: 1, amount: eth(3), from: EXT, to: OWNED });
    await S.checkpoint(OWNED, 'native', 'live');
    await S.checkpoint(OWNED, 'erc20', 'live');

    const env = await ledgerStatus(ctx(), {});

    expect(env.data.wallets).toHaveLength(1);
    const w = env.data.wallets[0]!;
    expect(w.address).toBe(OWNED);
    expect(w.chain_id).toBe(1);
    expect(w.streams.map((s) => s.stream)).toEqual(['erc20', 'native']); // sorted
    expect(w.streams.every((s) => s.status === 'live')).toBe(true);
    expect(w.streams.every((s) => s.last_processed_block === 100)).toBe(true);
    // native stream saw an event → last_block_time present
    expect(w.streams.find((s) => s.stream === 'native')?.last_block_time).toBeDefined();

    // all-live-and-fresh ⇒ no coverage warnings (C5)
    expect(env.warnings).toHaveLength(0);
    // citations carry the coverage slice
    expect(env.citations.coverage.map((c) => `${String(c.chain_id)}:${c.status}`)).toContain('1:live');

    // C2: tool_call persisted before responding
    const { rows } = await pool.query(`SELECT id, tenant_id, tool_name FROM tool_calls`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: env.citations.tool_call_id, tenant_id: TENANT, tool_name: 'ledger_status' });
  });

  it('surfaces C5 warnings and stream detail for a backfilling, stale, anchored wallet', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await S.checkpoint(OWNED, 'native', 'backfilling', { anchorBlock: 10, updatedAt: stale });
    await S.checkpoint(OWNED, 'erc20', 'live');

    const env = await ledgerStatus(ctx(), {});
    expect(env.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['COVERAGE_INCOMPLETE', 'ANCHORED_BASELINE', 'DATA_STALE']),
    );
    const native = env.data.wallets[0]!.streams.find((s) => s.stream === 'native')!;
    expect(native.status).toBe('backfilling');
    expect(native.anchor_block).toBe(10);
  });

  it('exposes the integrity drift check with clean derived from drifts', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.checkpoint(OWNED, 'native', 'live');
    await pool.query(
      `UPDATE ingestion_checkpoints SET last_integrity = $1 WHERE address = $2 AND stream = 'native'`,
      [JSON.stringify({ checked_at: '2026-06-01T00:00:00Z', block: 100, drifts: [{ token: 'USDC', computed: '4', provider: '5' }] }), OWNED],
    );

    const env = await ledgerStatus(ctx(), {});
    const integ = env.data.wallets[0]!.integrity!;
    expect(integ.clean).toBe(false); // drifts present ⇒ not clean
    expect(integ.block).toBe(100);
    expect(integ.drifts).toEqual([{ token: 'USDC', computed: '4', provider: '5' }]);
  });

  it('a freshly-queued wallet reports queued streams with no last_block_time and an incomplete warning', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.checkpoint(OWNED, 'native', 'queued');
    await S.checkpoint(OWNED, 'erc20', 'queued');

    const env = await ledgerStatus(ctx(), {});
    const w = env.data.wallets[0]!;
    expect(w.streams.every((s) => s.status === 'queued')).toBe(true);
    expect(w.streams.every((s) => s.last_block_time === undefined)).toBe(true);
    expect(env.warnings.map((x) => x.code)).toContain('COVERAGE_INCOMPLETE');
    // F5: a not-yet-started stream must not read as 'live' in the coverage slice
    expect(env.citations.coverage[0]!.status).toBe('backfilling');
  });

  it('surfaces the >50k probe estimate with suggests_anchored when the hint exceeds the threshold', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.checkpoint(OWNED, 'native', 'queued');
    await S.checkpoint(OWNED, 'erc20', 'queued');
    await pool.query(
      `UPDATE ingestion_checkpoints SET tx_count_hint = 75000 WHERE address = $1 AND stream = 'native'`,
      [OWNED],
    );

    const env = await ledgerStatus(ctx(), {});
    expect(env.data.wallets[0]!.estimate).toEqual({ tx_count_hint: 75000, suggests_anchored: true });
  });

  it('reports the hint but suppresses the suggestion once the wallet is already anchored', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.checkpoint(OWNED, 'native', 'backfilling', { anchorBlock: 10 });
    await pool.query(
      `UPDATE ingestion_checkpoints SET tx_count_hint = 90000 WHERE address = $1 AND stream = 'native'`,
      [OWNED],
    );

    const env = await ledgerStatus(ctx(), {});
    expect(env.data.wallets[0]!.estimate).toEqual({ tx_count_hint: 90000, suggests_anchored: false });
  });

  it('is tenant-scoped: another tenant cannot reach an address it does not track', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.checkpoint(OWNED, 'native', 'live');
    await S.tenant(TENANT2, 'other');
    await S.wallet(WALLET_OWNED2, TENANT2, OWNED2);
    const ctx2: ToolContext = { db, tenantId: TENANT2 };

    await expect(ledgerStatus(ctx2, { scope: { addresses: [OWNED] } })).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    await expect(ledgerStatus(ctx(), { bogus: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

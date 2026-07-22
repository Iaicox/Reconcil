import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ToolError } from '../src/errors.js';
import { analyticsGas } from '../src/tools/analytics-gas.js';
import {
  OWNED, SINK, TENANT, TENANT2, WALLET_OWNED,
  eth, makeSeeder, type Seeder,
} from './seed.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let S: Seeder;

const PERIOD = { from: '2026-06-01', to: '2026-06-30' };
const MONTH_END = '2026-06-30';

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

/** OWNED pays 2 ETH gas on Jun 15 and 1 ETH on Jun 20. */
async function seedGasWorld(): Promise<void> {
  await S.tenant(TENANT, 'acme');
  await S.wallet(WALLET_OWNED, TENANT, OWNED);
  await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
  await S.event({ tokenId: 1, amount: eth(2), from: OWNED, to: SINK, kind: 'gas_fee', day: '2026-06-15' });
  await S.event({ tokenId: 1, amount: eth(1), from: OWNED, to: SINK, kind: 'gas_fee', day: '2026-06-20' });
  await S.checkpoint(OWNED, 'native', 'live');
}

describe('analytics_gas — envelope, grouping, valuation, tenancy', () => {
  it('sums fee spend per chain and persists the tool_call (C2)', async () => {
    await seedGasWorld();
    const env = await analyticsGas(ctx(), { period: PERIOD });

    expect(env.data.rows).toHaveLength(1);
    expect(env.data.rows[0]).toMatchObject({ group: { chain: '1' }, native_amount: '3', tx_count: 2 });
    // gas is native-only → no spam filter → no UNVERIFIED_EXCLUDED
    expect(env.warnings.map((w) => w.code)).not.toContain('UNVERIFIED_EXCLUDED');

    const { rows } = await pool.query(`SELECT id, tenant_id, tool_name, result_digest FROM tool_calls`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: env.citations.tool_call_id, tenant_id: TENANT, tool_name: 'analytics_gas' });
    expect((rows[0] as { result_digest: string }).result_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('subdivides by month (chain stays in the group)', async () => {
    await seedGasWorld();
    const env = await analyticsGas(ctx(), { period: PERIOD, group_by: ['month'] });
    expect(env.data.rows).toHaveLength(1);
    expect(env.data.rows[0]).toMatchObject({ group: { chain: '1', month: '2026-06' }, native_amount: '3' });
  });

  it('values fee spend in USD with pinned price refs (C4)', async () => {
    await seedGasWorld();
    await S.snapshot(1, '2000', MONTH_END); // chain-only grouping → representative date = period.to = month end
    const env = await analyticsGas(ctx(), { period: PERIOD, valuation: { currency: 'USD' } });
    expect(env.data.rows[0]?.fiat_value).toBe('6000'); // 3 × 2000
    expect(env.citations.price_refs).toHaveLength(1);
    expect(env.citations.price_refs?.[0]).toMatchObject({ source: 'defillama', date: MONTH_END });
  });

  it('emits PRICE_MISSING and omits fiat_value when no snapshot exists', async () => {
    await seedGasWorld();
    const env = await analyticsGas(ctx(), { period: PERIOD, valuation: { currency: 'USD' } });
    expect(env.data.rows[0]?.fiat_value).toBeUndefined();
    expect(env.warnings.map((w) => w.code)).toContain('PRICE_MISSING');
  });

  it('summarizes backing as event_ref_summary → analytics_list_events with kinds=[gas_fee] (C3)', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
    for (let i = 0; i < 65; i += 1) await S.event({ tokenId: 1, amount: eth(1), from: OWNED, to: SINK, kind: 'gas_fee' });
    await S.checkpoint(OWNED, 'native', 'live');

    const env = await analyticsGas(ctx(), { period: PERIOD });
    expect(env.citations.event_refs).toBeUndefined();
    expect(env.citations.event_ref_summary?.count).toBe(65);
    expect(env.citations.event_ref_summary?.drilldown).toMatchObject({ tool: 'analytics_list_events', args: { kinds: ['gas_fee'] } });
  });

  it('surfaces coverage warnings: incomplete, anchored, stale (C5)', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
    await S.event({ tokenId: 1, amount: eth(1), from: OWNED, to: SINK, kind: 'gas_fee' });
    const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await S.checkpoint(OWNED, 'native', 'backfilling', { anchorBlock: 10, updatedAt: stale });

    const env = await analyticsGas(ctx(), { period: PERIOD });
    expect(env.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['COVERAGE_INCOMPLETE', 'ANCHORED_BASELINE', 'DATA_STALE']),
    );
  });

  it('is tenant-scoped: another tenant cannot reach an address it does not track', async () => {
    await seedGasWorld();
    await S.tenant(TENANT2, 'other');
    const ctx2: ToolContext = { db, tenantId: TENANT2 };
    await expect(analyticsGas(ctx2, { period: PERIOD, scope: { addresses: [OWNED] } })).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    await seedGasWorld();
    await expect(analyticsGas(ctx(), { period: PERIOD, group_by: ['token'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(analyticsGas(ctx(), {})).rejects.toMatchObject({ code: 'INVALID_INPUT' }); // period required
  });
});

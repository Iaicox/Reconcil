import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ToolError } from '../src/errors.js';
import { analyticsCounterparties } from '../src/tools/analytics-counterparties.js';
import {
  EXT, EXT2, OWNED, TENANT, TENANT2, WALLET_OWNED,
  eth, makeSeeder, stable6, type Seeder,
} from './seed.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let S: Seeder;

const PERIOD = { from: '2026-06-01', to: '2026-06-30' };

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

/**
 * EXT (multi-token): +100/−40 ETH and +500 USDC ⇒ tx_count 3.
 * EXT2: +1000 USDC ⇒ tx_count 1. USDC inflow partitions 500 + 1000 = 1500.
 */
async function seedCpWorld(): Promise<void> {
  await S.tenant(TENANT, 'acme');
  await S.wallet(WALLET_OWNED, TENANT, OWNED);
  await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
  await S.token(2, { decimals: 6, symbol: 'USDC' });
  await S.event({ tokenId: 1, amount: eth(100), from: EXT, to: OWNED });
  await S.event({ tokenId: 1, amount: eth(40), from: OWNED, to: EXT });
  await S.event({ tokenId: 2, amount: stable6(500), from: EXT, to: OWNED });
  await S.event({ tokenId: 2, amount: stable6(1000), from: EXT2, to: OWNED });
  await S.checkpoint(OWNED, 'native', 'live');
  await S.checkpoint(OWNED, 'erc20', 'live');
}

describe('analytics_counterparties — per-token turnover, labels, valuation, tenancy', () => {
  it('reports per-token turnover ranked by activity and persists the tool_call (C2/C3)', async () => {
    await seedCpWorld();
    const env = await analyticsCounterparties(ctx(), { period: PERIOD });

    expect(env.data.rows).toHaveLength(2);
    const ext = env.data.rows[0]!; // tx_count 3 ranks first
    expect(ext.counterparty).toEqual({ kind: 'address', address: EXT });
    expect(ext.tx_count).toBe(3);
    expect(ext.tokens).toEqual(['ETH', 'USDC']); // per_token sorted by token id
    expect(ext.per_token[0]).toMatchObject({ token: { symbol: 'ETH' }, inflow: '100', outflow: '40' });
    expect(ext.per_token[1]).toMatchObject({ token: { symbol: 'USDC' }, inflow: '500', outflow: '0' });

    const ext2 = env.data.rows[1]!;
    expect(ext2.counterparty).toEqual({ kind: 'address', address: EXT2 });
    expect(ext2.tx_count).toBe(1);

    // both unlabeled → the whole tx volume is the "please label me" nudge
    expect(env.data.unlabeled_share).toEqual({ tx_count: 4, hint: 'directory_upsert_entity' });

    expect(env.citations.coverage.map((c) => `${String(c.chain_id)}:${c.status}`)).toContain('1:live');
    expect((env.citations.event_refs?.length ?? 0) + (env.citations.event_ref_summary?.count ?? 0)).toBeGreaterThan(0);

    const { rows } = await pool.query(`SELECT id, tenant_id, tool_name, result_digest FROM tool_calls`);
    expect(rows[0]).toMatchObject({ id: env.citations.tool_call_id, tenant_id: TENANT, tool_name: 'analytics_counterparties' });
    expect((rows[0] as { result_digest: string }).result_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('labels a counterparty from the address book; tenant rows shadow curated (P1)', async () => {
    await seedCpWorld();
    // EXT has both a curated and a tenant label → tenant wins.
    const curatedExt = await S.entity({ tenantId: null, name: 'Binance', kind: 'exchange' });
    await S.entityAddress({ entityId: curatedExt, tenantId: null, chainId: null, address: EXT });
    const mine = await S.entity({ tenantId: TENANT, name: 'My CEX', kind: 'exchange' });
    await S.entityAddress({ entityId: mine, tenantId: TENANT, chainId: null, address: EXT });
    // EXT2 only has a curated label.
    const curatedExt2 = await S.entity({ tenantId: null, name: 'Kraken', kind: 'exchange' });
    await S.entityAddress({ entityId: curatedExt2, tenantId: null, chainId: null, address: EXT2 });

    const env = await analyticsCounterparties(ctx(), { period: PERIOD });
    const ext = env.data.rows.find((r) => r.tx_count === 3)!;
    expect(ext.counterparty).toEqual({ kind: 'entity', entity_id: mine, name: 'My CEX', entity_kind: 'exchange', curated: false });
    const ext2 = env.data.rows.find((r) => r.tx_count === 1)!;
    expect(ext2.counterparty).toEqual({ kind: 'entity', entity_id: curatedExt2, name: 'Kraken', entity_kind: 'exchange', curated: true });

    expect(env.data.unlabeled_share.tx_count).toBe(0); // everything labeled
  });

  it('values per-token inflow/outflow and rolls up a summable counterparty fiat (C4)', async () => {
    await seedCpWorld();
    await S.snapshot(1, '2000', PERIOD.to); // ETH
    await S.snapshot(2, '1', PERIOD.to); // USDC

    const env = await analyticsCounterparties(ctx(), { period: PERIOD, valuation: { currency: 'USD' } });
    const ext = env.data.rows.find((r) => r.tx_count === 3)!;
    expect(ext.per_token[0]?.fiat).toEqual({ inflow: '200000', outflow: '80000' }); // 100/40 × 2000
    expect(ext.per_token[1]?.fiat).toEqual({ inflow: '500', outflow: '0' }); // 500/0 × 1
    expect(ext.fiat).toEqual({ inflow: '200500', outflow: '80000' }); // summed across tokens
    expect(env.citations.price_refs).toHaveLength(2);
  });

  it('omits fiat and warns PRICE_MISSING when a snapshot is absent', async () => {
    await seedCpWorld();
    const env = await analyticsCounterparties(ctx(), { period: PERIOD, valuation: { currency: 'USD' } });
    const ext = env.data.rows.find((r) => r.tx_count === 3)!;
    expect(ext.fiat).toBeUndefined();
    expect(ext.per_token.every((p) => p.fiat === undefined)).toBe(true);
    expect(env.warnings.map((w) => w.code)).toContain('PRICE_MISSING');
  });

  it('partitions turnover: Σ per-counterparty inflow per token = total (property #3)', async () => {
    await seedCpWorld();
    const env = await analyticsCounterparties(ctx(), { period: PERIOD });
    const usdcInflow = env.data.rows
      .flatMap((r) => r.per_token.filter((p) => p.token.symbol === 'USDC'))
      .reduce((sum, p) => sum + Number(p.inflow), 0);
    expect(usdcInflow).toBe(1500); // 500 (EXT) + 1000 (EXT2)
  });

  it('honours top_n, ranking counterparties by activity', async () => {
    await seedCpWorld();
    const env = await analyticsCounterparties(ctx(), { period: PERIOD, top_n: 1 });
    expect(env.data.rows).toHaveLength(1);
    expect(env.data.rows[0]?.tx_count).toBe(3); // EXT, the busiest
    // unlabeled_share is over the RETURNED page (§6.1): EXT2 (tx 1) is truncated, so 3 not 4.
    expect(env.data.unlabeled_share.tx_count).toBe(3);
  });

  it('summarizes backing as event_ref_summary + drilldown past the ref cap (C3)', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
    for (let i = 0; i < 65; i += 1) await S.event({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED });
    await S.checkpoint(OWNED, 'native', 'live');

    const env = await analyticsCounterparties(ctx(), { period: PERIOD });
    expect(env.citations.event_refs).toBeUndefined();
    expect(env.citations.event_ref_summary?.count).toBe(65);
    expect(env.citations.event_ref_summary?.sample.length).toBeLessThanOrEqual(10);
    expect(env.citations.event_ref_summary?.drilldown.tool).toBe('analytics_list_events');
  });

  it('surfaces coverage warnings: incomplete, anchored, stale (C5)', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
    await S.event({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED });
    const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await S.checkpoint(OWNED, 'native', 'backfilling', { anchorBlock: 10, updatedAt: stale });

    const env = await analyticsCounterparties(ctx(), { period: PERIOD });
    expect(env.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['COVERAGE_INCOMPLETE', 'ANCHORED_BASELINE', 'DATA_STALE']),
    );
  });

  it('excludes unverified tokens by default and includes them on request', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
    await S.token(2, { decimals: 6, symbol: 'SPAM', verified: false });
    await S.event({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED });
    await S.event({ tokenId: 2, amount: stable6(9), from: EXT2, to: OWNED });
    await S.checkpoint(OWNED, 'native', 'live');

    const def = await analyticsCounterparties(ctx(), { period: PERIOD });
    expect(def.data.rows.map((r) => (r.counterparty.kind === 'address' ? r.counterparty.address : ''))).toEqual([EXT]);
    expect(def.warnings.map((w) => w.code)).toContain('UNVERIFIED_EXCLUDED');

    const all = await analyticsCounterparties(ctx(), { period: PERIOD, include_unverified: true });
    expect(all.data.rows).toHaveLength(2);
  });

  it('is tenant-scoped: another tenant cannot reach an address it does not track', async () => {
    await seedCpWorld();
    await S.tenant(TENANT2, 'other');
    const ctx2: ToolContext = { db, tenantId: TENANT2 };
    await expect(analyticsCounterparties(ctx2, { period: PERIOD, scope: { addresses: [OWNED] } })).rejects.toBeInstanceOf(ToolError);
  });

  it('does not leak another tenant label into resolution', async () => {
    await seedCpWorld();
    await S.tenant(TENANT2, 'other');
    const otherLabel = await S.entity({ tenantId: TENANT2, name: 'Not Mine', kind: 'exchange' });
    await S.entityAddress({ entityId: otherLabel, tenantId: TENANT2, chainId: null, address: EXT });

    const env = await analyticsCounterparties(ctx(), { period: PERIOD });
    const ext = env.data.rows.find((r) => r.tx_count === 3)!;
    expect(ext.counterparty).toEqual({ kind: 'address', address: EXT }); // TENANT2's label is invisible
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    await seedCpWorld();
    await expect(analyticsCounterparties(ctx(), {})).rejects.toMatchObject({ code: 'INVALID_INPUT' }); // period required
    await expect(analyticsCounterparties(ctx(), { period: PERIOD, top_n: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(analyticsCounterparties(ctx(), { period: PERIOD, direction: 'sideways' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

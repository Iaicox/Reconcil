import { chainEvents, createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ToolError } from '../src/errors.js';
import { analyticsFlows } from '../src/tools/analytics-flows.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let seq = 0;

const TENANT = '00000000-0000-0000-0000-000000000001';
const TENANT2 = '00000000-0000-0000-0000-000000000002';
const OWNED = '0x00000000000000000000000000000000000000a1';
const OWNED2 = '0x00000000000000000000000000000000000000a2';
const EXT = '0x00000000000000000000000000000000000000e1';
const EXT2 = '0x00000000000000000000000000000000000000e2';
const PERIOD = { from: '2026-06-01', to: '2026-06-30' };
const YEAR = { from: '2026-01-01', to: '2026-12-31' };

const eth = (n: number): bigint => BigInt(n) * 10n ** 18n;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

beforeEach(async () => {
  await pool.query('TRUNCATE tenants, wallets, chain_events, tokens, price_snapshots, fx_rates, ingestion_checkpoints, tool_calls RESTART IDENTITY CASCADE');
  seq = 0;
});

async function seedTenant(id: string, slug: string): Promise<void> {
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
}
async function seedWallet(id: string, tenantId: string, address: string): Promise<void> {
  await pool.query(`INSERT INTO wallets (id, tenant_id, address) VALUES ($1, $2, $3)`, [id, tenantId, address]);
}
async function seedToken(
  id: number,
  o: { decimals?: number; symbol?: string; isStablecoin?: boolean; pegCurrency?: string | null; verified?: boolean; address?: string | null } = {},
): Promise<void> {
  const { decimals = 18, symbol = `T${String(id)}`, isStablecoin = false, pegCurrency = null, verified = true } = o;
  const standard = o.address === null ? 'native' : 'erc20';
  const address = o.address === undefined ? `0x${id.toString(16).padStart(40, '0')}` : o.address;
  await pool.query(
    `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
     OVERRIDING SYSTEM VALUE VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, address, standard, decimals, isStablecoin, pegCurrency, verified, symbol],
  );
}
async function seedEvent(o: { tokenId: number; amount: bigint; from: string; to: string; day?: string }): Promise<void> {
  seq += 1;
  const kind = o.tokenId === 1 ? 'native_transfer' : 'erc20_transfer';
  await db.insert(chainEvents).values({
    chainId: 1, txHash: `0x${seq.toString(16).padStart(64, '0')}`, logIndex: kind === 'native_transfer' ? -1 : 0,
    eventKind: kind, tokenId: o.tokenId, amountRaw: o.amount,
    fromAddr: o.from, toAddr: o.to, blockNumber: seq, blockTime: new Date(`${o.day ?? '2026-06-15'}T12:00:00Z`),
    txFrom: o.from, txTo: o.to, provider: 'fixture', raw: {},
  });
}
async function seedCheckpoint(
  address: string, stream: string, status: string,
  opts: { anchorBlock?: number; updatedAt?: string } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block, anchor_block, updated_at)
     VALUES (1, $1, $2, $3, 100, $4, $5)`,
    [address, stream, status, opts.anchorBlock ?? null, opts.updatedAt ?? new Date().toISOString()],
  );
}
async function seedSnapshot(tokenId: number, price: string, date: string): Promise<void> {
  await pool.query(
    `INSERT INTO price_snapshots (token_id, price_date, currency, price, source) VALUES ($1,$2,'USD',$3,'defillama')`,
    [tokenId, date, price],
  );
}

/** ETH scenario: EXT→OWNED 100 (in), OWNED→EXT 40 (out), OWNED→OWNED2 25 (internal). */
async function seedFlowWorld(): Promise<void> {
  await seedTenant(TENANT, 'acme');
  await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
  await seedWallet('00000000-0000-0000-0000-0000000000a2', TENANT, OWNED2);
  await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
  await seedEvent({ tokenId: 1, amount: eth(100), from: EXT, to: OWNED });
  await seedEvent({ tokenId: 1, amount: eth(40), from: OWNED, to: EXT });
  await seedEvent({ tokenId: 1, amount: eth(25), from: OWNED, to: OWNED2 });
  await seedCheckpoint(OWNED, 'native', 'live');
  await seedCheckpoint(OWNED2, 'native', 'live');
}

const ctx: () => ToolContext = () => ({ db, tenantId: TENANT });

describe('analytics_flows — envelope, grouping, valuation, tenancy', () => {
  it('splits external in/out/net and reports internal transfers separately (C2/C3)', async () => {
    await seedFlowWorld();
    const env = await analyticsFlows(ctx(), { period: PERIOD });

    expect(env.data.rows).toHaveLength(1);
    expect(env.data.rows[0]).toMatchObject({ group: { token: 'ETH' }, inflow: '100', outflow: '40', net: '60', tx_count: 2 });
    expect(env.data.internal_transfers).toHaveLength(1);
    expect(env.data.internal_transfers[0]).toMatchObject({ group: { token: 'ETH' }, inflow: '25', outflow: '25', net: '0' });

    expect(env.citations.coverage.map((c) => `${String(c.chain_id)}:${c.status}`)).toContain('1:live');
    expect((env.citations.event_refs?.length ?? 0) + (env.citations.event_ref_summary?.count ?? 0)).toBeGreaterThan(0);

    // C2: tool_call persisted before responding, matching digest.
    const { rows } = await pool.query(`SELECT id, tenant_id, tool_name, result_digest FROM tool_calls`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: env.citations.tool_call_id, tenant_id: TENANT, tool_name: 'analytics_flows' });
    expect((rows[0] as { result_digest: string }).result_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honours direction=in', async () => {
    await seedFlowWorld();
    const env = await analyticsFlows(ctx(), { period: PERIOD, direction: 'in' });
    expect(env.data.rows[0]).toMatchObject({ inflow: '100', outflow: '0' });
  });

  it('subdivides by month', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    await seedEvent({ tokenId: 1, amount: eth(100), from: EXT, to: OWNED, day: '2026-01-15' });
    await seedEvent({ tokenId: 1, amount: eth(30), from: EXT, to: OWNED, day: '2026-06-15' });
    await seedCheckpoint(OWNED, 'native', 'live');

    const env = await analyticsFlows(ctx(), { period: YEAR, group_by: ['month'] });
    const byMonth = new Map(env.data.rows.map((r) => [r.group.month, r]));
    expect([...byMonth.keys()].sort()).toEqual(['2026-01', '2026-06']);
    expect(byMonth.get('2026-01')).toMatchObject({ group: { token: 'ETH', month: '2026-01' }, inflow: '100' });
    expect(byMonth.get('2026-06')).toMatchObject({ group: { token: 'ETH', month: '2026-06' }, inflow: '30' });
  });

  it('subdivides by counterparty', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    await seedEvent({ tokenId: 1, amount: eth(100), from: EXT, to: OWNED });
    await seedEvent({ tokenId: 1, amount: eth(40), from: EXT2, to: OWNED });
    await seedCheckpoint(OWNED, 'native', 'live');

    const env = await analyticsFlows(ctx(), { period: PERIOD, group_by: ['counterparty'] });
    const byCp = new Map(env.data.rows.map((r) => [r.group.counterparty, r]));
    expect(byCp.get(EXT)).toMatchObject({ inflow: '100' });
    expect(byCp.get(EXT2)).toMatchObject({ inflow: '40' });
  });

  it('values inflow/outflow in USD with pinned price refs (C4)', async () => {
    await seedFlowWorld();
    await seedSnapshot(1, '2000', PERIOD.to); // representative date for token-only grouping = period.to
    const env = await analyticsFlows(ctx(), { period: PERIOD, valuation: { currency: 'USD' } });
    expect(env.data.rows[0]?.fiat).toEqual({ inflow: '200000', outflow: '80000' }); // 100×2000, 40×2000
    expect(env.citations.price_refs).toHaveLength(1);
    expect(env.citations.price_refs?.[0]).toMatchObject({ source: 'defillama', date: PERIOD.to });
  });

  it('emits PRICE_MISSING and omits fiat when no snapshot exists', async () => {
    await seedFlowWorld();
    const env = await analyticsFlows(ctx(), { period: PERIOD, valuation: { currency: 'USD' } });
    expect(env.data.rows[0]?.fiat).toBeUndefined();
    expect(env.warnings.map((w) => w.code)).toContain('PRICE_MISSING');
  });

  it('summarizes backing as event_ref_summary + drilldown past the ref cap (C3)', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    for (let i = 0; i < 65; i += 1) await seedEvent({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED });
    await seedCheckpoint(OWNED, 'native', 'live');

    const env = await analyticsFlows(ctx(), { period: PERIOD });
    expect(env.citations.event_refs).toBeUndefined();
    expect(env.citations.event_ref_summary?.count).toBeGreaterThan(64);
    expect(env.citations.event_ref_summary?.sample.length).toBeLessThanOrEqual(10);
    expect(env.citations.event_ref_summary?.drilldown.tool).toBe('analytics_list_events');
  });

  it('surfaces coverage warnings: incomplete, anchored, stale (C5)', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    await seedEvent({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED });
    const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await seedCheckpoint(OWNED, 'native', 'backfilling', { anchorBlock: 10, updatedAt: stale });

    const env = await analyticsFlows(ctx(), { period: PERIOD });
    expect(env.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['COVERAGE_INCOMPLETE', 'ANCHORED_BASELINE', 'DATA_STALE']),
    );
  });

  it('is tenant-scoped: another tenant cannot reach an address it does not track', async () => {
    await seedFlowWorld();
    await seedTenant(TENANT2, 'other');
    await seedWallet('00000000-0000-0000-0000-0000000000b2', TENANT2, EXT);
    const ctx2: ToolContext = { db, tenantId: TENANT2 };
    await expect(analyticsFlows(ctx2, { period: PERIOD, scope: { addresses: [OWNED] } })).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    await seedFlowWorld();
    await expect(analyticsFlows(ctx(), { period: PERIOD, group_by: ['bogus'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(analyticsFlows(ctx(), { period: { from: 'yesterday', to: '2026-06-30' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(analyticsFlows(ctx(), {})).rejects.toMatchObject({ code: 'INVALID_INPUT' }); // period required
  });

  it('carries chain_id in every group so same-symbol tokens stay distinct', async () => {
    await seedFlowWorld();
    const env = await analyticsFlows(ctx(), { period: PERIOD });
    expect(env.data.rows[0]?.group.chain_id).toBe('1');
    expect(env.data.internal_transfers[0]?.group.chain_id).toBe('1');
  });

  it('a token filter matching nothing yields empty flows, not "no filter"', async () => {
    await seedFlowWorld();
    const env = await analyticsFlows(ctx(), { period: PERIOD, token: { chain_id: 1, address: '0x00000000000000000000000000000000deadbeef' } });
    expect(env.data.rows).toHaveLength(0);
    expect(env.data.internal_transfers).toHaveLength(0);
  });

  it('values a month bucket at the month-end snapshot', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    await seedEvent({ tokenId: 1, amount: eth(10), from: EXT, to: OWNED, day: '2026-06-15' });
    await seedCheckpoint(OWNED, 'native', 'live');
    await seedSnapshot(1, '2000', '2026-06-30'); // month-end representative date

    const env = await analyticsFlows(ctx(), { period: PERIOD, group_by: ['month'], valuation: { currency: 'USD' } });
    const row = env.data.rows.find((r) => r.group.month === '2026-06');
    expect(row?.fiat).toEqual({ inflow: '20000', outflow: '0' }); // 10 × 2000
    expect(env.citations.price_refs?.[0]).toMatchObject({ date: '2026-06-30' });
  });

  it('values internal transfers too', async () => {
    await seedFlowWorld();
    await seedSnapshot(1, '2000', PERIOD.to); // token-only grouping → representative date = period.to
    const env = await analyticsFlows(ctx(), { period: PERIOD, valuation: { currency: 'USD' } });
    expect(env.data.internal_transfers[0]?.fiat).toEqual({ inflow: '50000', outflow: '50000' }); // 25 × 2000 each side
  });

  it('excludes unverified tokens by default and includes them on request', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    await seedToken(2, { decimals: 6, symbol: 'SPAM', verified: false });
    await seedEvent({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED });
    await seedEvent({ tokenId: 2, amount: 1_000000n, from: EXT, to: OWNED });
    await seedCheckpoint(OWNED, 'native', 'live');

    const def = await analyticsFlows(ctx(), { period: PERIOD });
    expect(def.data.rows.map((r) => r.group.token)).toEqual(['ETH']);
    expect(def.warnings.map((w) => w.code)).toContain('UNVERIFIED_EXCLUDED');

    const all = await analyticsFlows(ctx(), { period: PERIOD, include_unverified: true });
    expect(new Set(all.data.rows.map((r) => r.group.token))).toEqual(new Set(['ETH', 'SPAM']));
  });
});

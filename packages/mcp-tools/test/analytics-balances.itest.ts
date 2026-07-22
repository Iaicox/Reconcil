import { chainEvents, createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ToolError } from '../src/errors.js';
import { analyticsBalances } from '../src/tools/analytics-balances.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let seq = 0;

const TENANT = '00000000-0000-0000-0000-000000000001';
const TENANT2 = '00000000-0000-0000-0000-000000000002';
const OWNED = '0x00000000000000000000000000000000000000a1';
const OWNED2 = '0x00000000000000000000000000000000000000a2';
const EXT = '0x00000000000000000000000000000000000000e1';
const DATE = '2026-06-01';

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
  o: { decimals?: number; symbol?: string; isStablecoin?: boolean; pegCurrency?: string | null; verified?: boolean; address?: string | null; standard?: string } = {},
): Promise<void> {
  const { decimals = 18, symbol = `T${String(id)}`, isStablecoin = false, pegCurrency = null, verified = true } = o;
  const standard = o.standard ?? (o.address === null ? 'native' : 'erc20');
  const address = o.address === undefined ? `0x${id.toString(16).padStart(40, '0')}` : o.address;
  await pool.query(
    `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
     OVERRIDING SYSTEM VALUE VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, address, standard, decimals, isStablecoin, pegCurrency, verified, symbol],
  );
}
async function seedEvent(tokenId: number, amount: bigint): Promise<void> {
  seq += 1;
  await db.insert(chainEvents).values({
    chainId: 1, txHash: `0x${seq.toString(16).padStart(64, '0')}`, logIndex: tokenId === 1 ? -1 : 0,
    eventKind: tokenId === 1 ? 'native_transfer' : 'erc20_transfer', tokenId, amountRaw: amount,
    fromAddr: EXT, toAddr: OWNED, blockNumber: seq, blockTime: new Date(`${DATE}T12:00:00Z`),
    txFrom: EXT, txTo: OWNED, provider: 'fixture', raw: {},
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
async function seedSnapshot(tokenId: number, price: string): Promise<void> {
  await pool.query(
    `INSERT INTO price_snapshots (token_id, price_date, currency, price, source) VALUES ($1,$2,'USD',$3,'defillama')`,
    [tokenId, DATE, price],
  );
}
async function seedFx(rate: string): Promise<void> {
  await pool.query(
    `INSERT INTO fx_rates (rate_date, base_currency, quote_currency, rate, source) VALUES ($1,'EUR','USD',$2,'ecb')`,
    [DATE, rate],
  );
}

async function seedWorld(): Promise<void> {
  await seedTenant(TENANT, 'acme');
  await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
  await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
  await seedToken(2, { decimals: 6, symbol: 'USDC', isStablecoin: true, pegCurrency: 'USD' });
  await seedToken(3, { decimals: 6, symbol: 'SPAM', verified: false });
  await seedEvent(1, 3_000000000000000000n); // 3 ETH
  await seedEvent(2, 1000_000000n); // 1000 USDC
  await seedEvent(3, 999n); // spam
  await seedCheckpoint(OWNED, 'native', 'live');
  await seedCheckpoint(OWNED, 'erc20', 'live');
}

const ctx: () => ToolContext = () => ({ db, tenantId: TENANT });

describe('analytics_balances — envelope, citations, warnings, tenancy', () => {
  it('returns balances, excludes spam by default, and cites/covers (C3/C5/C2)', async () => {
    await seedWorld();
    const env = await analyticsBalances(ctx(), {});

    const symbols = env.data.balances.map((b) => b.token.symbol).sort();
    expect(symbols).toEqual(['ETH', 'USDC']); // SPAM excluded
    expect(env.data.balances.find((b) => b.token.symbol === 'ETH')?.amount).toBe('3');
    expect(env.data.balances.find((b) => b.token.symbol === 'USDC')?.amount).toBe('1000');

    expect(env.warnings.map((w) => w.code)).toContain('UNVERIFIED_EXCLUDED');
    expect(env.citations.coverage.map((c) => `${String(c.chain_id)}:${c.status}`)).toContain('1:live');
    // C3: backing present as refs or a summary
    expect((env.citations.event_refs?.length ?? 0) + (env.citations.event_ref_summary?.count ?? 0)).toBeGreaterThan(0);

    // C2: tool_call persisted before responding, with a matching digest
    const { rows } = await pool.query(`SELECT id, tenant_id, tool_name, result_digest FROM tool_calls`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: env.citations.tool_call_id, tenant_id: TENANT, tool_name: 'analytics_balances' });
    expect((rows[0] as { result_digest: string }).result_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('values in USD with pinned price refs and totals (C4)', async () => {
    await seedWorld();
    await seedSnapshot(1, '2000'); // ETH
    await seedSnapshot(2, '1'); // USDC market

    const env = await analyticsBalances(ctx(), { valuation: { currency: 'USD' } });
    const eth = env.data.balances.find((b) => b.token.symbol === 'ETH');
    expect(eth?.fiat_value).toBe('6000'); // 3 × 2000
    expect(env.data.totals).toEqual([{ currency: 'USD', value: '7000' }]); // 6000 + 1000
    expect(env.citations.price_refs).toHaveLength(2);
    expect(env.citations.price_refs?.every((p) => p.source === 'defillama')).toBe(true);
  });

  it('emits PRICE_MISSING and omits the value when a snapshot is absent', async () => {
    await seedWorld();
    await seedSnapshot(1, '2000'); // ETH priced, USDC missing
    const env = await analyticsBalances(ctx(), { valuation: { currency: 'USD' } });
    expect(env.data.balances.find((b) => b.token.symbol === 'USDC')?.fiat_value).toBeUndefined();
    expect(env.warnings.map((w) => w.code)).toContain('PRICE_MISSING');
  });

  it('is tenant-scoped: another tenant cannot reach an address it does not track', async () => {
    await seedWorld();
    await seedTenant(TENANT2, 'other');
    await seedWallet('00000000-0000-0000-0000-0000000000b2', TENANT2, OWNED2);
    const ctx2: ToolContext = { db, tenantId: TENANT2 };

    // TENANT2's own scope: no events → empty balances, not TENANT's data.
    const env = await analyticsBalances(ctx2, {});
    expect(env.data.balances).toHaveLength(0);

    // Explicitly asking for TENANT's address is rejected, not served.
    await expect(analyticsBalances(ctx2, { scope: { addresses: [OWNED] } })).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    await seedWorld();
    await expect(analyticsBalances(ctx(), { bogus: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // as_of must be an ISO date, not an arbitrary string
    await expect(analyticsBalances(ctx(), { as_of: 'yesterday' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('summarizes backing as event_ref_summary + drilldown past the ref cap (C3)', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    for (let i = 0; i < 65; i += 1) await seedEvent(1, 1_000000000000000000n); // 65 > REF_CAP (64)
    await seedCheckpoint(OWNED, 'native', 'live');

    const env = await analyticsBalances(ctx(), {});
    expect(env.citations.event_refs).toBeUndefined();
    expect(env.citations.event_ref_summary?.count).toBeGreaterThan(64);
    expect(env.citations.event_ref_summary?.sample.length).toBeLessThanOrEqual(10);
    expect(env.citations.event_ref_summary?.drilldown.tool).toBe('analytics_list_events');
  });

  it('surfaces coverage warnings: incomplete, anchored, stale (C5)', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    await seedEvent(1, 1_000000000000000000n);
    const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await seedCheckpoint(OWNED, 'native', 'backfilling', { anchorBlock: 10, updatedAt: stale });

    const env = await analyticsBalances(ctx(), {});
    expect(env.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['COVERAGE_INCOMPLETE', 'ANCHORED_BASELINE', 'DATA_STALE']),
    );
  });

  it('values in EUR via the ECB rate with fx_refs and an explicit as_of', async () => {
    await seedTenant(TENANT, 'acme');
    await seedWallet('00000000-0000-0000-0000-0000000000a1', TENANT, OWNED);
    await seedToken(1, { decimals: 18, symbol: 'ETH', address: null });
    await seedEvent(1, 3_000000000000000000n);
    await seedCheckpoint(OWNED, 'native', 'live');
    await seedSnapshot(1, '2000'); // USD price; EUR valuation needs FX
    await seedFx('1.08');

    const env = await analyticsBalances(ctx(), { valuation: { currency: 'EUR' }, as_of: DATE });
    const eth = env.data.balances.find((b) => b.token.symbol === 'ETH');
    expect(eth?.fiat_value?.startsWith('5555.55')).toBe(true); // 3 × 2000 ÷ 1.08
    expect(env.citations.fx_refs).toHaveLength(1);
    expect(env.data.totals).toEqual([{ currency: 'EUR', value: eth?.fiat_value }]);
  });
});

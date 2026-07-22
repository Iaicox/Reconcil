import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { analyticsStablecoinMovements } from '../src/tools/analytics-stablecoin-movements.js';
import {
  EXT, OWNED, OWNED2, TENANT, WALLET_OWNED, WALLET_OWNED2,
  eth, makeSeeder, stable6, type Seeder,
} from './seed.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let S: Seeder;

const PERIOD = { from: '2026-06-01', to: '2026-06-30' };
const REP_DATE = '2026-06-30'; // token-only grouping → representative date = period.to

// token ids: 1 native, 2 USDC (USD peg), 5 EURC (EUR peg), 4 USDT (USD peg, unverified)
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

async function seedStableWorld(): Promise<void> {
  await S.tenant(TENANT, 'acme');
  await S.wallet(WALLET_OWNED, TENANT, OWNED);
  await S.wallet(WALLET_OWNED2, TENANT, OWNED2);
  await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
  await S.token(2, { decimals: 6, symbol: 'USDC', isStablecoin: true, pegCurrency: 'USD' });
  await S.token(5, { decimals: 6, symbol: 'EURC', isStablecoin: true, pegCurrency: 'EUR' });
  await S.token(4, { decimals: 6, symbol: 'USDT', isStablecoin: true, pegCurrency: 'USD', verified: false });
  await S.event({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED }); // native — excluded
  await S.event({ tokenId: 2, amount: stable6(1000), from: EXT, to: OWNED }); // USDC in
  await S.event({ tokenId: 2, amount: stable6(200), from: OWNED, to: EXT }); // USDC out
  await S.event({ tokenId: 5, amount: stable6(500), from: EXT, to: OWNED }); // EURC in
  await S.event({ tokenId: 4, amount: stable6(999), from: EXT, to: OWNED }); // USDT — unverified, excluded
  await S.checkpoint(OWNED, 'native', 'live');
  await S.checkpoint(OWNED, 'erc20', 'live');
  await S.checkpoint(OWNED2, 'erc20', 'live');
}

/** Peg snapshots (source='peg', price 1 in the peg currency) on the representative date. */
async function seedPegSnapshots(): Promise<void> {
  await S.snapshot(2, '1', REP_DATE, { currency: 'USD', source: 'peg' });
  await S.snapshot(5, '1', REP_DATE, { currency: 'EUR', source: 'peg' });
}

describe('analytics_stablecoin_movements — restriction, peg subtotals, envelope', () => {
  it('restricts flows to verified stablecoins and persists the tool_call (C2)', async () => {
    await seedStableWorld();
    const env = await analyticsStablecoinMovements(ctx(), { period: PERIOD });
    expect(new Set(env.data.rows.map((r) => r.group.token))).toEqual(new Set(['USDC', 'EURC'])); // no ETH, no USDT

    const { rows } = await pool.query(`SELECT id, tenant_id, tool_name FROM tool_calls`);
    expect(rows[0]).toMatchObject({ id: env.citations.tool_call_id, tenant_id: TENANT, tool_name: 'analytics_stablecoin_movements' });
  });

  it('reports per-peg subtotals at face value under peg policy, pinned by peg price_refs (C4)', async () => {
    await seedStableWorld();
    await seedPegSnapshots();
    const env = await analyticsStablecoinMovements(ctx(), { period: PERIOD });

    const byPeg = new Map(env.data.peg_subtotals.map((s) => [s.peg_currency, s]));
    expect(byPeg.get('USD')).toEqual({ peg_currency: 'USD', inflow: '1000', outflow: '200' });
    expect(byPeg.get('EUR')).toEqual({ peg_currency: 'EUR', inflow: '500', outflow: '0' });
    // every subtotal component cites a synthetic source='peg' snapshot
    expect(env.citations.price_refs?.every((r) => r.source === 'peg')).toBe(true);
    expect(env.citations.price_refs?.length).toBe(2);
  });

  it('omits fiat where the peg snapshot is missing and raises PRICE_MISSING (never interpolated)', async () => {
    await seedStableWorld(); // no peg snapshots seeded
    const env = await analyticsStablecoinMovements(ctx(), { period: PERIOD });
    // no snapshots → subtotals sum to 0, PRICE_MISSING surfaced
    const usd = env.data.peg_subtotals.find((s) => s.peg_currency === 'USD');
    expect(usd).toEqual({ peg_currency: 'USD', inflow: '0', outflow: '0' });
    expect(env.warnings.map((w) => w.code)).toContain('PRICE_MISSING');
    expect(env.citations.price_refs).toBeUndefined();
  });

  it('narrows to a single peg currency', async () => {
    await seedStableWorld();
    await seedPegSnapshots();
    const env = await analyticsStablecoinMovements(ctx(), { period: PERIOD, peg_currency: 'USD' });
    expect(env.data.rows.map((r) => r.group.token)).toEqual(['USDC']);
    expect(env.data.peg_subtotals.map((s) => s.peg_currency)).toEqual(['USD']);
  });

  it('reports self-transfers in internal_transfers, never as external flow', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.wallet(WALLET_OWNED2, TENANT, OWNED2);
    await S.token(2, { decimals: 6, symbol: 'USDC', isStablecoin: true, pegCurrency: 'USD' });
    await S.event({ tokenId: 2, amount: stable6(1000), from: EXT, to: OWNED }); // external in
    await S.event({ tokenId: 2, amount: stable6(300), from: OWNED, to: OWNED2 }); // internal self-transfer
    await S.checkpoint(OWNED, 'erc20', 'live');
    await S.checkpoint(OWNED2, 'erc20', 'live');

    const env = await analyticsStablecoinMovements(ctx(), { period: PERIOD });
    expect(env.data.rows).toHaveLength(1);
    expect(env.data.rows[0]).toMatchObject({ inflow: '1000', outflow: '0' });
    expect(env.data.internal_transfers).toHaveLength(1);
    expect(env.data.internal_transfers[0]).toMatchObject({ inflow: '300', outflow: '300' });
  });

  it('subdivides by month', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(2, { decimals: 6, symbol: 'USDC', isStablecoin: true, pegCurrency: 'USD' });
    await S.event({ tokenId: 2, amount: stable6(1000), from: EXT, to: OWNED, day: '2026-05-10' });
    await S.event({ tokenId: 2, amount: stable6(400), from: EXT, to: OWNED, day: '2026-06-10' });
    await S.checkpoint(OWNED, 'erc20', 'live');

    const env = await analyticsStablecoinMovements(ctx(), { period: { from: '2026-01-01', to: '2026-12-31' }, group_by: ['month'] });
    const byMonth = new Map(env.data.rows.map((r) => [r.group.month, r]));
    expect(byMonth.get('2026-05')).toMatchObject({ inflow: '1000' });
    expect(byMonth.get('2026-06')).toMatchObject({ inflow: '400' });
  });

  it('rejects malformed input with INVALID_INPUT (no day dimension, no valuation)', async () => {
    await seedStableWorld();
    await expect(analyticsStablecoinMovements(ctx(), { period: PERIOD, group_by: ['day'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(analyticsStablecoinMovements(ctx(), { period: PERIOD, valuation: { currency: 'USD' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

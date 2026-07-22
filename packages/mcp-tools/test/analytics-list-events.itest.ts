import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ToolError } from '../src/errors.js';
import { analyticsListEvents } from '../src/tools/analytics-list-events.js';
import {
  EXT, OWNED, OWNED2, SINK, TENANT, TENANT2, WALLET_OWNED, WALLET_OWNED2,
  eth, makeSeeder, stable6, type Seeder,
} from './seed.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let S: Seeder;

const tokenAddr = (id: number): string => `0x${id.toString(16).padStart(40, '0')}`;

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

/** Mixed world: native in/out/internal + gas + verified USDC + unverified SPAM. */
async function seedMixed(): Promise<void> {
  await S.tenant(TENANT, 'acme');
  await S.wallet(WALLET_OWNED, TENANT, OWNED);
  await S.wallet(WALLET_OWNED2, TENANT, OWNED2);
  await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
  await S.token(2, { decimals: 6, symbol: 'USDC' });
  await S.token(3, { decimals: 6, symbol: 'SPAM', verified: false });
  await S.event({ tokenId: 1, amount: eth(100), from: EXT, to: OWNED }); // in
  await S.event({ tokenId: 1, amount: eth(40), from: OWNED, to: EXT }); // out
  await S.event({ tokenId: 1, amount: eth(25), from: OWNED, to: OWNED2 }); // internal
  await S.event({ tokenId: 1, amount: eth(1), from: OWNED, to: SINK, kind: 'gas_fee' });
  await S.event({ tokenId: 2, amount: stable6(1000), from: EXT, to: OWNED }); // USDC in
  await S.event({ tokenId: 3, amount: stable6(999), from: EXT, to: OWNED }); // SPAM in (unverified)
  await S.checkpoint(OWNED, 'native', 'live');
  await S.checkpoint(OWNED, 'erc20', 'live');
  await S.checkpoint(OWNED2, 'native', 'live');
}

describe('analytics_list_events — listing, filters, pagination, citations', () => {
  it('maps events to the wire shape and inlines event_refs; persists the tool_call (C2)', async () => {
    await seedMixed();
    const env = await analyticsListEvents(ctx(), { kinds: ['erc20_transfer'] });

    expect(env.data.events).toHaveLength(1);
    const ev = env.data.events[0]!;
    expect(ev).toMatchObject({
      chain_id: 1, kind: 'erc20_transfer', amount: '1000', amount_raw: '1000000000',
      token: { symbol: 'USDC', address: tokenAddr(2), decimals: 6 },
      from: { address: EXT }, to: { address: OWNED }, direction: 'in',
    });
    expect(typeof ev.block_time).toBe('string');

    // citations are the returned page itself (inline, under the cap)
    expect(env.citations.event_refs).toHaveLength(1);
    expect(env.citations.event_ref_summary).toBeUndefined();

    const { rows } = await pool.query(`SELECT id, tool_name, tenant_id FROM tool_calls`);
    expect(rows[0]).toMatchObject({ id: env.citations.tool_call_id, tool_name: 'analytics_list_events', tenant_id: TENANT });
  });

  it('excludes unverified tokens by default; includes them on request', async () => {
    await seedMixed();
    const def = await analyticsListEvents(ctx(), {});
    expect(def.data.total_count).toBe(5); // SPAM excluded
    expect(def.data.events.some((e) => e.token.symbol === 'SPAM')).toBe(false);
    const all = await analyticsListEvents(ctx(), { include_unverified: true });
    expect(all.data.total_count).toBe(6);
  });

  it('labels direction in/out/internal relative to the scope', async () => {
    await seedMixed();
    const env = await analyticsListEvents(ctx(), { kinds: ['native_transfer'] });
    const dir = new Map(env.data.events.map((e) => [e.amount, e.direction]));
    expect(dir.get('100')).toBe('in');
    expect(dir.get('40')).toBe('out');
    expect(dir.get('25')).toBe('internal');
  });

  it('filters by kind and by token', async () => {
    await seedMixed();
    const gas = await analyticsListEvents(ctx(), { kinds: ['gas_fee'] });
    expect(gas.data.events.map((e) => e.amount)).toEqual(['1']);
    const usdc = await analyticsListEvents(ctx(), { tokens: [{ chain_id: 1, address: tokenAddr(2) }] });
    expect(usdc.data.events.map((e) => e.token.symbol)).toEqual(['USDC']);
  });

  it('applies min_amount as a per-token display threshold', async () => {
    await seedMixed();
    const env = await analyticsListEvents(ctx(), { min_amount: '50' });
    // native 100 and USDC 1000 clear 50; native 40/25/1 do not; SPAM excluded (unverified)
    expect(new Set(env.data.events.map((e) => e.amount))).toEqual(new Set(['100', '1000']));
  });

  it('paginates: total_count on the first page only, next_cursor drives the rest', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
    for (let i = 0; i < 5; i += 1) await S.event({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED });
    await S.checkpoint(OWNED, 'native', 'live');

    const first = await analyticsListEvents(ctx(), { limit: 2 });
    expect(first.data.total_count).toBe(5);
    expect(first.data.next_cursor).toBeDefined();
    expect(first.data.events).toHaveLength(2);

    const second = await analyticsListEvents(ctx(), { limit: 2, cursor: first.data.next_cursor });
    expect(second.data.total_count).toBeUndefined();
    expect(second.data.events).toHaveLength(2);
  });

  it('summarizes past the ref cap: event_ref_summary + self-drilldown (C3)', async () => {
    await S.tenant(TENANT, 'acme');
    await S.wallet(WALLET_OWNED, TENANT, OWNED);
    await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
    for (let i = 0; i < 65; i += 1) await S.event({ tokenId: 1, amount: eth(1), from: EXT, to: OWNED });
    await S.checkpoint(OWNED, 'native', 'live');

    const env = await analyticsListEvents(ctx(), { limit: 200 });
    expect(env.citations.event_refs).toBeUndefined();
    expect(env.citations.event_ref_summary?.count).toBe(65);
    expect(env.citations.event_ref_summary?.sample.length).toBeLessThanOrEqual(10);
    expect(env.citations.event_ref_summary?.drilldown.tool).toBe('analytics_list_events');
  });

  it('rejects a malformed min_amount as INVALID_INPUT (not an opaque INTERNAL)', async () => {
    await seedMixed();
    // '-5' passes the DecimalString regex but the ledger guards non-negative → RangeError → INVALID_INPUT
    await expect(analyticsListEvents(ctx(), { min_amount: '-5' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an over-limit request with INVALID_INPUT', async () => {
    await seedMixed();
    await expect(analyticsListEvents(ctx(), { limit: 201 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('is tenant-scoped: another tenant cannot reach an address it does not track', async () => {
    await seedMixed();
    await S.tenant(TENANT2, 'other');
    const ctx2: ToolContext = { db, tenantId: TENANT2 };
    await expect(analyticsListEvents(ctx2, { scope: { addresses: [OWNED] } })).rejects.toBeInstanceOf(ToolError);
  });
});

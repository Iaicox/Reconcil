import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ledgerTrackWallet } from '../src/tools/ledger-track-wallet.js';
import { OWNED, TENANT, TENANT2, makeSeeder, type Seeder } from './seed.js';

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function checkpointRows(): Promise<{ chain_id: number; address: string; stream: string; status: string }[]> {
  const { rows } = await pool.query(
    `SELECT chain_id, address, stream, status FROM ingestion_checkpoints ORDER BY chain_id, stream`,
  );
  return rows as { chain_id: number; address: string; stream: string; status: string }[];
}

describe('ledger_track_wallet — onboarding write, idempotency, tenancy', () => {
  it('tracks a new wallet: creates it, queues both streams, returns deterministic job ids (C2)', async () => {
    await S.tenant(TENANT, 'acme');
    const env = await ledgerTrackWallet(ctx(), { address: OWNED, chains: [1] });

    expect(env.data.wallet_id).toMatch(UUID);
    expect([...env.data.enqueued].sort((a, b) => a.job_id.localeCompare(b.job_id))).toEqual([
      { chain_id: 1, stream: 'erc20', job_id: `backfill:1:${OWNED}:erc20` },
      { chain_id: 1, stream: 'native', job_id: `backfill:1:${OWNED}:native` },
    ]);

    const cps = await checkpointRows();
    expect(cps).toHaveLength(2);
    expect(cps.every((c) => c.status === 'queued' && c.address === OWNED)).toBe(true);

    const wallets = await pool.query(`SELECT tenant_id, address FROM wallets`);
    expect(wallets.rows).toEqual([{ tenant_id: TENANT, address: OWNED }]);

    const calls = await pool.query(`SELECT tool_name FROM tool_calls`);
    expect(calls.rows).toEqual([{ tool_name: 'ledger_track_wallet' }]);
  });

  it('is idempotent: re-tracking returns the same wallet_id without duplicating rows', async () => {
    await S.tenant(TENANT, 'acme');
    const first = await ledgerTrackWallet(ctx(), { address: OWNED, chains: [1], label: 'treasury' });
    const second = await ledgerTrackWallet(ctx(), { address: OWNED, chains: [1] });

    expect(second.data.wallet_id).toBe(first.data.wallet_id);
    expect((await pool.query(`SELECT count(*)::int AS n FROM wallets`)).rows[0]).toEqual({ n: 1 });
    expect(await checkpointRows()).toHaveLength(2);
    expect((await pool.query(`SELECT label FROM wallets`)).rows[0]).toEqual({ label: 'treasury' });
  });

  it('does not disturb an in-progress stream on re-track', async () => {
    await S.tenant(TENANT, 'acme');
    await S.checkpoint(OWNED, 'native', 'live');
    await ledgerTrackWallet(ctx(), { address: OWNED, chains: [1] });

    const cps = await checkpointRows();
    expect(cps.find((c) => c.stream === 'native')?.status).toBe('live'); // preserved
    expect(cps.find((c) => c.stream === 'erc20')?.status).toBe('queued'); // newly seeded
  });

  it('defaults to all enabled chains when none are given', async () => {
    await S.tenant(TENANT, 'acme');
    const env = await ledgerTrackWallet(ctx(), { address: OWNED });
    expect(env.data.enqueued).toHaveLength(4); // (1, 8453) × (native, erc20)
    expect(new Set(env.data.enqueued.map((e) => e.chain_id))).toEqual(new Set([1, 8453]));
    expect(await checkpointRows()).toHaveLength(4);
  });

  it('lowercases the address before writing', async () => {
    await S.tenant(TENANT, 'acme');
    const mixed = '0x00000000000000000000000000000000000000A1';
    const env = await ledgerTrackWallet(ctx(), { address: mixed, chains: [1] });
    expect(env.data.enqueued[0]!.job_id).toContain(OWNED); // lowercase
    expect((await pool.query(`SELECT address FROM wallets`)).rows[0]).toEqual({ address: OWNED });
  });

  it('rejects anchored mode until it is wired (Part B)', async () => {
    await S.tenant(TENANT, 'acme');
    await expect(
      ledgerTrackWallet(ctx(), { address: OWNED, mode: 'anchored', anchored_from: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an unknown chain and malformed input with INVALID_INPUT', async () => {
    await S.tenant(TENANT, 'acme');
    await expect(ledgerTrackWallet(ctx(), { address: OWNED, chains: [999] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(ledgerTrackWallet(ctx(), {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('shares global checkpoints across tenants tracking the same address', async () => {
    await S.tenant(TENANT, 'acme');
    await S.tenant(TENANT2, 'other');
    const a = await ledgerTrackWallet(ctx(), { address: OWNED, chains: [1] });
    const b = await ledgerTrackWallet({ db, tenantId: TENANT2 }, { address: OWNED, chains: [1] });

    expect(b.data.wallet_id).not.toBe(a.data.wallet_id); // per-tenant wallet rows
    expect((await pool.query(`SELECT count(*)::int AS n FROM wallets`)).rows[0]).toEqual({ n: 2 });
    expect(await checkpointRows()).toHaveLength(2); // one global (chain, address, stream) set
  });
});

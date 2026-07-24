/**
 * Ground-truth `numbers` for the native eval cases (04-testing.md §5/§6, P1/P2). The
 * figures in core-30.yaml must come from the fixture-seeded DB, never hand-authored — so
 * this itest seeds the freelancer wallet (native+internal+gas, reconciled to
 * eth_get_balance) and runs the real analytics tools over it, asserting the values pinned
 * in the dataset. It both DOCUMENTS how each number was derived and GUARDS it against
 * drift. No LLM — deterministic, runs in the integration CI job.
 */
import { analyticsBalances, analyticsGas, type ToolContext } from '@pet-crypto/mcp-tools';
import { createDb, runMigrations, tenants, wallets, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDataset, seedGoldenWallet } from '../src/index.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATASET = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'evals', 'core-30.yaml');
const WIDE_PERIOD = { from: '2015-07-30', to: '2026-07-17' } as const; // ETH genesis → capture date

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE tenants, tokens, chain_events RESTART IDENTITY CASCADE');
});

/** Seed the freelancer wallet + a tenant tracking it, and return the tool context. */
async function seedFreelancer(): Promise<ToolContext> {
  const seeded = await seedGoldenWallet(db, 'freelancer', 1);
  const [tenant] = await db.insert(tenants).values({ slug: 'evals', name: 'Evals' }).returning({ id: tenants.id });
  await db.insert(wallets).values({ tenantId: tenant!.id, address: seeded.address });
  return { db, tenantId: tenant!.id };
}

/** The dataset's pinned {value} for a case's numbers (single-number native cases). */
function pinnedNumbers(id: string): string[] {
  const c = loadDataset(DATASET).find((x) => x.id === id);
  return (c?.expect.numbers ?? []).map((n) => n.value);
}

describe('native ground-truth numbers (freelancer, chain 1)', () => {
  it('gas-001: total gas equals analytics_gas over the wallet history', async () => {
    const ctx = await seedFreelancer();
    const env = await analyticsGas(ctx, { period: WIDE_PERIOD });
    const chainRow = env.data.rows.find((r) => r.group['chain'] === '1');
    expect(chainRow).toBeDefined();
    expect(pinnedNumbers('gas-001')).toContain(chainRow!.native_amount);
  });

  it('bal-002 / cover-001: current ETH balance equals analytics_balances (reconciled to eth_get_balance)', async () => {
    const ctx = await seedFreelancer();
    const env = await analyticsBalances(ctx, {});
    const nativeRow = env.data.balances.find((b) => b.token.address === null);
    expect(nativeRow).toBeDefined();
    for (const id of ['bal-002', 'cover-001']) {
      expect(pinnedNumbers(id)).toContain(nativeRow!.amount);
    }
  });
});

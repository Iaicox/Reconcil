import { eq } from 'drizzle-orm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, runMigrations, type Db } from '../src/index.js';
import { ensureSelfHostTenant } from '../src/tenants.js';
import { tenants } from '../src/schema.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

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
  await pool.query('TRUNCATE tenants RESTART IDENTITY CASCADE');
});

describe('ensureSelfHostTenant', () => {
  it('creates the tenant on first call and returns the same id on repeat calls', async () => {
    const first = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    const second = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    expect(second).toBe(first);
  });

  it('a rename made outside ensureSelfHostTenant survives a later call (container restart)', async () => {
    const id = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');

    // Simulate a rename made through some other path (future settings UI, direct SQL).
    await db.update(tenants).set({ name: 'Renamed Co' }).where(eq(tenants.id, id));

    // Boot again with the ORIGINAL config name — must NOT revert the rename.
    const idAfterReboot = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    expect(idAfterReboot).toBe(id);

    const [row] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, id));
    expect(row?.name).toBe('Renamed Co');
  });
});

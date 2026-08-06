import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveScope } from '../src/scope.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-0000000000c1'; // canonical lowercase
const CLIENT_NO_WALLETS = '00000000-0000-0000-0000-0000000000c2';
const UNKNOWN_CLIENT = '00000000-0000-0000-0000-0000000000cf'; // well-formed, no row anywhere

const WALLET = `0x${'1'.repeat(40)}`;

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
  await pool.query('TRUNCATE tenants, clients, wallets RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'acme')`, [TENANT]);
  await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Client One')`, [CLIENT, TENANT]);
  await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Client No Wallets')`, [CLIENT_NO_WALLETS, TENANT]);
  await pool.query(`INSERT INTO wallets (tenant_id, client_id, address) VALUES ($1, $2, $3)`, [TENANT, CLIENT, WALLET]);
});

describe('resolveScope — client_id hardening (C3a)', () => {
  it('resolves a mixed-case client_id via a canonical lowercase compare', async () => {
    const { addresses } = await resolveScope({ db, tenantId: TENANT }, { client_id: CLIENT.toUpperCase() });
    expect(addresses).toEqual([WALLET]);
  });

  it('throws UNKNOWN_SCOPE naming the id for a client_id with no clients row at all', async () => {
    await expect(resolveScope({ db, tenantId: TENANT }, { client_id: UNKNOWN_CLIENT }))
      .rejects.toMatchObject({ code: 'UNKNOWN_SCOPE' });
    await expect(resolveScope({ db, tenantId: TENANT }, { client_id: UNKNOWN_CLIENT }))
      .rejects.toThrow(UNKNOWN_CLIENT);
  });

  it('keeps COVERAGE_EMPTY (not UNKNOWN_SCOPE) for a known client with zero tracked wallets', async () => {
    await expect(resolveScope({ db, tenantId: TENANT }, { client_id: CLIENT_NO_WALLETS }))
      .rejects.toMatchObject({ code: 'COVERAGE_EMPTY' });
  });
});

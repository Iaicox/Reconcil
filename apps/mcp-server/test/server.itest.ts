import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureSelfHostTenant, hashKey, resolveTenantByBearer } from '../src/auth.js';
import { mintKey } from '../src/keygen.js';
import { createServer } from '../src/server.js';

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
  await pool.query('TRUNCATE tenants, wallets, ingestion_checkpoints, tool_calls, api_keys RESTART IDENTITY CASCADE');
});

describe('auth — transport → tenant boundary', () => {
  it('ensureSelfHostTenant is idempotent (same id on repeat)', async () => {
    const first = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    const second = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    expect(second).toBe(first);
  });

  it('resolveTenantByBearer maps a live key to its tenant, rejects absent/revoked', async () => {
    const tenantId = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    const key = await mintKey(db, 'self-host', 'itest');

    expect(await resolveTenantByBearer(db, key)).toBe(tenantId);
    expect(await resolveTenantByBearer(db, 'not-a-real-key')).toBeNull();

    await pool.query('UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1', [hashKey(key)]);
    expect(await resolveTenantByBearer(db, key)).toBeNull();
  });
});

describe('mcp-server — tool call through createServer persists provenance (C2)', () => {
  it('a ledger_status call returns the envelope and writes a tenant-scoped tool_call', async () => {
    const tenantId = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    const walletId = '00000000-0000-0000-0000-0000000000a1';
    const addr = '0x00000000000000000000000000000000000000a1';
    await pool.query('INSERT INTO wallets (id, tenant_id, address) VALUES ($1, $2, $3)', [walletId, tenantId, addr]);
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block)
       VALUES (1, $1, 'native', 'live', 100), (1, $1, 'erc20', 'live', 100)`,
      [addr],
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(() => ({ db, tenantId }));
    await server.connect(serverTransport);
    const client = new Client({ name: 'itest', version: '0.0.0' });
    await client.connect(clientTransport);

    try {
      const res = await client.callTool({ name: 'ledger_status', arguments: {} });
      expect(res.isError).toBeFalsy();

      const envelope = res.structuredContent as {
        data: { wallets: unknown[] };
        citations: { tool_call_id: string };
      };
      expect(envelope.data.wallets).toHaveLength(1);

      const { rows } = await pool.query('SELECT id, tenant_id, tool_name FROM tool_calls');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: envelope.citations.tool_call_id,
        tenant_id: tenantId,
        tool_name: 'ledger_status',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

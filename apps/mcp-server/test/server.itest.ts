import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDb, ensureSelfHostTenant, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashKey, resolveTenantByBearer } from '../src/auth.js';
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

  it('an expired key is rejected, and is indistinguishable from an unknown one', async () => {
    await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    const key = await mintKey(db, 'self-host', 'itest', 30);
    expect(await resolveTenantByBearer(db, key)).not.toBeNull();

    await pool.query("UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE key_hash = $1", [hashKey(key)]);
    // Same null the unknown-key path returns: the caller answers a bare 401 either way, so
    // a probe cannot learn that a key exists and merely ran out.
    expect(await resolveTenantByBearer(db, key)).toBeNull();
    expect(await resolveTenantByBearer(db, 'not-a-real-key')).toBeNull();
  });

  it('a key minted with no expiry never expires — existing keys are unaffected', async () => {
    const tenantId = await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    const key = await mintKey(db, 'self-host', 'itest');

    const { rows } = await pool.query<{ expires_at: Date | null }>(
      'SELECT expires_at FROM api_keys WHERE key_hash = $1',
      [hashKey(key)],
    );
    expect(rows[0]!.expires_at).toBeNull();
    expect(await resolveTenantByBearer(db, key)).toBe(tenantId);
  });

  it('mintKey refuses a non-positive lifetime rather than minting a dead key', async () => {
    await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    await expect(mintKey(db, 'self-host', 'itest', 0)).rejects.toThrow(/positive number of days/);
    await expect(mintKey(db, 'self-host', 'itest', -1)).rejects.toThrow(/positive number of days/);
  });

  it('stamps last_used_at on first use, then throttles instead of writing per request', async () => {
    await ensureSelfHostTenant(db, 'self-host', 'Self-hosted');
    const key = await mintKey(db, 'self-host', 'itest');
    const stamp = async (): Promise<Date | null> => {
      const { rows } = await pool.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM api_keys WHERE key_hash = $1',
        [hashKey(key)],
      );
      return rows[0]!.last_used_at;
    };

    expect(await stamp()).toBeNull(); // minted, never presented
    await resolveTenantByBearer(db, key);
    const first = await stamp();
    expect(first).not.toBeNull();

    // A second call moments later must NOT write again — otherwise every authenticated
    // request carries an UPDATE, which is what the throttle exists to avoid.
    await resolveTenantByBearer(db, key);
    expect((await stamp())!.getTime()).toBe(first!.getTime());

    // Once the stamp is older than the refresh window, the next use moves it.
    await pool.query("UPDATE api_keys SET last_used_at = now() - interval '1 hour' WHERE key_hash = $1", [hashKey(key)]);
    await resolveTenantByBearer(db, key);
    expect((await stamp())!.getTime()).toBeGreaterThan(Date.now() - 60_000);
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

/**
 * The atomicity guarantee (C2): a write tool's domain mutation and its `tool_calls`
 * audit row commit in ONE transaction — a persist failure rolls the mutation back, so
 * a committed write can never lack its audit row. Proven with a real Postgres tx and no
 * mocks: force the in-transaction persist to fail (pre-minted colliding tool_call id →
 * PK 23505) and assert the domain row is absent afterwards.
 */
import { createDb, runMigrations, wallets, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext, TxContext } from '../src/context.js';
import { persistToolCall } from '../src/tool-calls.js';
import { runWriteTool } from '../src/write-tx.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const TENANT = '00000000-0000-0000-0000-000000000001';
const ADDR = '0x00000000000000000000000000000000000000a1';
const ADDR2 = '0x00000000000000000000000000000000000000a2';

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
  await pool.query('TRUNCATE tenants, wallets, tool_calls RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'acme')`, [TENANT]);
});

const ctx = (): ToolContext => ({ db, tenantId: TENANT });
const walletCount = async (): Promise<number> => {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM wallets`);
  return rows[0]!.n;
};

describe('runWriteTool — atomic write + audit', () => {
  it('commits the domain write and its tool_call together, and cites the id', async () => {
    const env = await runWriteTool<{ address: string }>(ctx(), {
      toolName: 'test_write',
      args: { a: 1 },
      body: async (txCtx: TxContext) => {
        await txCtx.db.insert(wallets).values({ tenantId: TENANT, address: ADDR });
        return { data: { address: ADDR }, envelope: { coverage: [] } };
      },
    });

    expect(env.citations.tool_call_id).toBeTruthy();
    expect(env.data.address).toBe(ADDR);
    expect(await walletCount()).toBe(1);

    const tc = await pool.query<{ tool_name: string; result_digest: string }>(
      `SELECT tool_name, result_digest FROM tool_calls WHERE id = $1`,
      [env.citations.tool_call_id],
    );
    expect(tc.rows).toHaveLength(1);
    expect(tc.rows[0]?.tool_name).toBe('test_write');
    expect(tc.rows[0]?.result_digest).toBeTruthy();
  });

  it('rolls the domain write back when the in-tx persist fails (no orphaned mutation)', async () => {
    // Seed a tool_call, then reuse its id so the helper's in-tx persist hits the PK.
    const clashId = await persistToolCall(ctx(), { toolName: 'seed', args: {}, coverage: [], result: {} });

    await expect(
      runWriteTool(ctx(), {
        toolName: 'test_write',
        args: {},
        toolCallId: clashId, // collides on the tool_calls PK → persist throws 23505 inside the tx
        body: async (txCtx: TxContext) => {
          await txCtx.db.insert(wallets).values({ tenantId: TENANT, address: ADDR2 });
          return { data: { address: ADDR2 }, envelope: { coverage: [] } };
        },
      }),
    ).rejects.toBeDefined();

    // The wallet insert must NOT have survived the rolled-back transaction.
    expect(await walletCount()).toBe(0);
    // And no second tool_call row appeared.
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tool_calls`);
    expect(rows[0]?.n).toBe(1);
  });
});

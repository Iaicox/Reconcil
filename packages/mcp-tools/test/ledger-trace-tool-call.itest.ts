import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ledgerTraceToolCall } from '../src/tools/ledger-trace-tool-call.js';
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

interface CallOpts { toolName: string; args: Record<string, unknown>; digest: string; coverage: unknown[] }
async function insertToolCall(id: string, tenantId: string, o: CallOpts): Promise<void> {
  await pool.query(
    `INSERT INTO tool_calls (id, tenant_id, tool_name, args, result_digest, coverage) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, tenantId, o.toolName, JSON.stringify(o.args), o.digest, JSON.stringify(o.coverage)],
  );
}

const COVERAGE = [{ chain_id: 1, address: OWNED, streams: ['native'], from_block: null, to_block: 100, status: 'live' }];

describe('ledger_trace_tool_call — audit replay (C2), tenancy', () => {
  it('replays a persisted call: name, args, coverage, digest', async () => {
    await S.tenant(TENANT, 'acme');
    await insertToolCall('01JTRACE', TENANT, {
      toolName: 'analytics_balances', args: { valuation: { currency: 'USD' } }, digest: 'a'.repeat(64), coverage: COVERAGE,
    });

    const env = await ledgerTraceToolCall(ctx(), { tool_call_id: '01JTRACE' });
    expect(env.data.tool_name).toBe('analytics_balances');
    expect(env.data.args).toEqual({ valuation: { currency: 'USD' } });
    expect(env.data.result_digest).toBe('a'.repeat(64));
    expect(env.data.coverage).toEqual(COVERAGE);
    expect(typeof env.data.called_at).toBe('string');
    expect(env.data.drilldown).toBeUndefined(); // not persisted this slice

    // C2 uniform: the trace itself is persisted (a second row, its own tool_name)
    const { rows } = await pool.query(`SELECT tool_name FROM tool_calls ORDER BY called_at`);
    expect(rows.map((r: { tool_name: string }) => r.tool_name)).toEqual(['analytics_balances', 'ledger_trace_tool_call']);
    expect(env.citations.tool_call_id).not.toBe('01JTRACE');
  });

  it('unknown id → INVALID_INPUT', async () => {
    await S.tenant(TENANT, 'acme');
    await expect(ledgerTraceToolCall(ctx(), { tool_call_id: 'nope' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('does not replay another tenant’s call', async () => {
    await S.tenant(TENANT, 'acme');
    await S.tenant(TENANT2, 'other');
    await insertToolCall('01JMINE', TENANT, { toolName: 'ledger_status', args: {}, digest: 'b'.repeat(64), coverage: [] });
    const ctx2: ToolContext = { db, tenantId: TENANT2 };
    await expect(ledgerTraceToolCall(ctx2, { tool_call_id: '01JMINE' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    await expect(ledgerTraceToolCall(ctx(), {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

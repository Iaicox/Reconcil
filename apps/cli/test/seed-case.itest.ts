/**
 * The eval seeder's ingestion checkpoints (04-testing.md §5).
 *
 * `ledger_status` is the tool the system prompt tells the agent to use "when freshness
 * matters", and it reads `ingestion_checkpoints` — a table the seeder TRUNCATEs. Until this
 * slice it never wrote one back, so the tool reported NO TRACKED WALLETS for all 30 cases
 * while the wallet row and its `chain_events` were both present. Two cases believed it and
 * correctly declined to answer (flow-002, flow-003-self-transfer, live run 2026-09-08).
 *
 * Hermetic tests cannot catch that: the defect only exists against a real database. Hence
 * an itest, and hence `apps/cli` gaining an integration suite. It asserts through the real
 * `ledger_status` handler over the seeder's own ToolContext rather than the ledger read
 * underneath, so what is pinned is exactly what the agent is told — envelope, warnings
 * and all.
 */
import { createDb, runMigrations, type Db } from '@reconcil/db';
import type { EvalCase } from '@reconcil/evals';
import { ledgerStatus } from '@reconcil/mcp-tools';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeSeedCase } from '../src/evals/seed-case.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  // A Pool with no 'error' listener turns a server-side disconnect into an UNHANDLED
  // error — apps/mcp-server/src/{http,stdio}.ts attach one for exactly this reason, and
  // stopping the container in afterAll IS such a disconnect.
  pool.on('error', () => { /* expected while the container is torn down */ });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

const faceA: EvalCase = {
  id: 'bal-x',
  face: 'A',
  question: 'balance?',
  setup: { fixture: 'freelancer' },
  expect: { tools_expected: ['analytics_balances'] },
};

const faceB: EvalCase = {
  id: 'recon-status-x',
  face: 'B',
  question: 'status?',
  setup: { fixture: 'recon-smb' },
  expect: { tools_expected: ['recon_status'] },
};

describe('eval seed-case → what ledger_status tells the agent', () => {
  it('a Face A golden wallet reports a live native stream at the ingested window', async () => {
    const { ctx } = await makeSeedCase(db)(faceA);

    const env = await ledgerStatus(ctx, {});
    expect(env.data.wallets).toHaveLength(1);

    const native = env.data.wallets[0]!.streams.find((s) => s.stream === 'native');
    expect(native?.status).toBe('live');
    // The cursor is the window seedGoldenWallet actually covered, so it is at or past
    // every event it wrote — "events complete for blocks <= last_processed_block".
    expect(native!.last_processed_block).toBeGreaterThan(0);
  });

  it('leaves erc20 queued, which is what gives cover-001 a real COVERAGE_INCOMPLETE', async () => {
    const { ctx } = await makeSeedCase(db)(faceA);

    const env = await ledgerStatus(ctx, {});
    const erc20 = env.data.wallets[0]!.streams.find((s) => s.stream === 'erc20');
    // Not pessimism: erc20 genuinely cannot be ingested yet (04-testing.md §2, unblocker a).
    expect(erc20?.status).toBe('queued');

    expect(env.warnings.map((w) => w.code)).toContain('COVERAGE_INCOMPLETE');
    // A wallet with a not-live stream must never read as fully covered.
    expect(env.citations.coverage[0]!.status).toBe('backfilling');
  });

  it('the Face B recon fixture claims the erc20 stream its settlements actually live on', async () => {
    const { ctx } = await makeSeedCase(db)(faceB);

    const env = await ledgerStatus(ctx, {});
    expect(env.data.wallets).toHaveLength(1);
    expect(env.data.wallets[0]!.streams.map((s) => s.stream)).toEqual(['erc20']);

    const erc20 = env.data.wallets[0]!.streams[0]!;
    expect(erc20.status).toBe('live');
    expect(erc20.last_processed_block).toBeGreaterThan(0);
    // No native stream is claimed, so nothing drags the recon snapshot to incomplete.
    expect(env.warnings.map((w) => w.code)).not.toContain('COVERAGE_INCOMPLETE');
  });

  it('reseeding truncates the checkpoints too — no duplicate-key crash on the second run', async () => {
    // runSuite reseeds before EVERY run now, so this path runs 3x per case in a live suite.
    const seed = makeSeedCase(db);
    await seed(faceA);
    const { ctx } = await seed(faceA);

    const env = await ledgerStatus(ctx, {});
    expect(env.data.wallets[0]!.streams).toHaveLength(2);
  });
});

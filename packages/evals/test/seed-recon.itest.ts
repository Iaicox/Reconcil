/**
 * The recon eval fixture (`recon-smb`, 04-testing.md §5). The Face B eval cases run the
 * agent against a seeded reconciliation scenario; this itest is the DETERMINISTIC, keyless
 * guard that the seed is well-formed and the recon tools behave over it — the recon
 * counterpart to `numbers.itest.ts` for the native cases. No LLM: it seeds the fixture and
 * drives the real suggest/status/journal tools, so a broken seed or a recon-contract drift
 * fails the integration job on every PR, not only when a live key runs the agent.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, runMigrations, tenants, type Db } from '@reconcil/db';
import {
  exportJournalDrafts,
  reconStatus,
  reconSuggestMatches,
  type ToolContext,
} from '@reconcil/mcp-tools';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { seedReconFixture } from '../src/index.js';

const PERIOD = { from: '2026-06-01', to: '2026-06-30' };
const MAPPING = { crypto_asset: '1010', accounts_receivable: '1100', accounts_payable: '2000', vat_output: '2200', vat_input: '1300' };

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let outDir: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
  outDir = await mkdtemp(join(tmpdir(), 'reconcil-seed-recon-'));
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
  await rm(outDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE tenants, clients, wallets, tokens, chain_events, external_records, matches, tool_calls, exports, ingestion_checkpoints RESTART IDENTITY CASCADE',
  );
});

/** A fresh tenant + the seeded recon-smb fixture, returning a tenant-scoped ctx + handles. */
async function seed(): Promise<{ ctx: ToolContext } & Awaited<ReturnType<typeof seedReconFixture>>> {
  const [tenant] = await db.insert(tenants).values({ slug: 'evals', name: 'Evals' }).returning({ id: tenants.id });
  const fixture = await seedReconFixture(db, tenant!.id, 'recon-smb');
  return { ctx: { db, tenantId: tenant!.id }, ...fixture };
}

describe('recon-smb eval fixture', () => {
  it('seeds one client, five records with the expected statuses, and three confirmed legs', async () => {
    const { ctx } = await seed();
    const clients = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM clients WHERE tenant_id = $1', [ctx.tenantId]);
    expect(clients.rows[0]?.n).toBe(1);

    const recs = await pool.query<{ external_ref: string; status: string; direction: string }>(
      'SELECT external_ref, status, direction FROM external_records WHERE tenant_id = $1 ORDER BY external_ref',
      [ctx.tenantId],
    );
    const byRef = Object.fromEntries(recs.rows.map((r) => [r.external_ref, r]));
    expect(Object.keys(byRef).sort()).toEqual(['BILL-OPEN', 'INV-OPEN', 'INV-PAID', 'INV-PARTIAL', 'INV-VAT']);
    // Non-null: presence of all five keys just asserted above.
    expect(byRef['INV-PAID']!.status).toBe('matched');
    expect(byRef['INV-VAT']!.status).toBe('matched');
    expect(byRef['INV-PARTIAL']!.status).toBe('partially_matched');
    expect(byRef['INV-OPEN']!.status).toBe('open');
    expect(byRef['BILL-OPEN']!.status).toBe('open');
    expect(byRef['BILL-OPEN']!.direction).toBe('payable');

    const legs = await pool.query<{ status: string }>('SELECT status FROM matches WHERE tenant_id = $1', [ctx.tenantId]);
    expect(legs.rows).toHaveLength(3);
    expect(legs.rows.every((l) => l.status === 'confirmed')).toBe(true);
  });

  it('leaves INV-OPEN and BILL-OPEN legless so recon_suggest_matches proposes exactly those two', async () => {
    const { ctx } = await seed();
    const env = await reconSuggestMatches(ctx, {});
    const refs = env.data.suggestions.map((s) => s.record.external_ref).sort();
    expect(refs).toEqual(['BILL-OPEN', 'INV-OPEN']);
  });

  it('reports the mixed reconciliation status (recon_status) with INV-PARTIAL outstanding', async () => {
    const { ctx } = await seed();
    const env = await reconStatus(ctx, {});
    expect(env.data.records).toMatchObject({ open: 2, partially_matched: 1, matched: 2, overpaid: 0, void: 0 });
    expect(env.data.open_amounts.some((a) => a.currency === 'EUR')).toBe(true);
  });

  it('journalizes the confirmed legs into a balanced QBO draft with the VAT split', async () => {
    const { ctx } = await seed();
    const env = await exportJournalDrafts(ctx, { period: PERIOD, target: 'qbo', account_mapping: MAPPING, out_dir: outDir });
    expect(env.data.balanced).toBe(true);
    expect(env.data.lines).toBe(7); // INV-PAID (2) + INV-VAT (3) + INV-PARTIAL (2)
    const csv = (await readFile(env.data.file.path)).toString('utf8');
    expect(csv).toContain('INV-VAT');
    expect(csv).toContain('2200,0.00,210.00'); // output VAT line: 1210 gross @21% → 210.00 VAT
    expect(csv).not.toContain('INV-OPEN'); // suggested/unmatched never journalized (P8)
  });
});

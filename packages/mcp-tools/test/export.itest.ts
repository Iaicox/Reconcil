import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { exportClosePack } from '../src/tools/export-close-pack.js';
import { exportPdfSummary } from '../src/tools/export-pdf-summary.js';
import { EXT, OWNED, TENANT, WALLET_OWNED, eth, makeSeeder, type Seeder } from './seed.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let S: Seeder;
let outDir: string;

const MONTH = '2026-06';
const OPENING_AS_OF = '2026-05-31';
const MONTH_END = '2026-06-30';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
  S = makeSeeder(pool, db);
  outDir = await mkdtemp(join(tmpdir(), 'pet-export-'));
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
  await rm(outDir, { recursive: true, force: true });
});

beforeEach(async () => { await S.truncate(); });

const ctx = (): ToolContext => ({ db, tenantId: TENANT });

/**
 * OWNED receives 10 ETH in May (opening), sends 3 ETH to EXT and pays 1 ETH gas
 * in June. ETH is priced at 2000 on both the opening and closing valuation dates.
 */
async function seedWorld(): Promise<void> {
  await S.tenant(TENANT, 'acme');
  await S.wallet(WALLET_OWNED, TENANT, OWNED);
  await S.token(1, { decimals: 18, symbol: 'ETH', address: null });
  await S.event({ tokenId: 1, amount: eth(10), from: EXT, to: OWNED, kind: 'native_transfer', day: '2026-05-20' });
  await S.event({ tokenId: 1, amount: eth(3), from: OWNED, to: EXT, kind: 'native_transfer', day: '2026-06-10' });
  await S.event({ tokenId: 1, amount: eth(1), from: OWNED, to: '0x0000000000000000000000000000000000000000', kind: 'gas_fee', day: '2026-06-11' });
  await S.snapshot(1, '2000', OPENING_AS_OF);
  await S.snapshot(1, '2000', MONTH_END);
  await S.checkpoint(OWNED, 'native', 'live');
}

function sha256File(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('export_close_pack — materialization, manifest, tenancy', () => {
  it('writes the 7-file bundle, registers the exports row, and persists the tool_call (C2)', async () => {
    await seedWorld();
    const env = await exportClosePack(ctx(), { month: MONTH, valuation: { currency: 'USD' }, out_dir: outDir });

    // --- output shape ---
    expect(env.data.kind).toBe('close_pack');
    expect(env.data.period).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    expect(env.data.export_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.data.files.map((f) => f.name)).toEqual([
      'balances_opening.csv', 'balances_closing.csv', 'transactions.csv',
      'gas.csv', 'counterparty_summary.csv', 'journal_draft.csv', 'manifest.json',
    ]);

    // --- files exist on disk with matching hashes ---
    for (const f of env.data.files) {
      const buf = await readFile(f.path);
      expect(sha256File(buf)).toBe(f.sha256);
    }

    // --- manifest on disk ---
    const manifestPath = env.data.files.find((f) => f.name === 'manifest.json')!.path;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      kind: string; draft: boolean; export_id: string; files: { name: string; sha256: string }[];
      rounding_residues: { currency: string; residue: string }[];
    };
    expect(manifest.kind).toBe('close_pack');
    expect(manifest.draft).toBe(true);
    expect(manifest.export_id).toBe(env.data.export_id);
    expect(manifest.files).toHaveLength(6);
    expect(manifest.rounding_residues).toEqual([{ currency: 'USD', residue: '0.00' }]);

    // --- journal balances per currency, with the expected amounts ---
    const journalPath = env.data.files.find((f) => f.name === 'journal_draft.csv')!.path;
    const journal = await readFile(journalPath, 'utf8');
    expect(journal).toContain('DRAFT — REVIEW REQUIRED');
    const rows = journal.trimEnd().split('\n').slice(2).map((r) => r.split(',')); // [date,account,desc,debit,credit,ccy]
    const debit = rows.reduce((a, r) => a + Number(r[3] ?? 0), 0);
    const credit = rows.reduce((a, r) => a + Number(r[4] ?? 0), 0);
    // Net ETH −3 @ 2000 = −6000 (asset credit), gas 1 ETH @ 2000 = 2000 (expense debit).
    expect(debit).toBeCloseTo(credit, 2);
    expect(debit).toBeCloseTo(8000, 2);
    const gasLines = rows.filter((r) => r[1] === 'Network Fees (gas)');
    expect(gasLines).toHaveLength(1); // gas counted once, not double
    expect(gasLines[0]?.[3]).toBe('2000.00');

    // --- citations ---
    expect(env.citations.tool_call_id).toBeDefined();
    expect(env.citations.price_refs?.length).toBeGreaterThan(0);

    // --- exports row registered ---
    const { rows: exp } = await pool.query(
      `SELECT status, kind, tenant_id, period_start::text AS period_start, period_end::text AS period_end, file_path, manifest FROM exports`,
    );
    expect(exp).toHaveLength(1);
    expect(exp[0]).toMatchObject({
      status: 'done', kind: 'close_pack', tenant_id: TENANT,
      period_start: '2026-06-01', period_end: '2026-06-30',
    });
    expect((exp[0] as { file_path: string }).file_path).toContain(env.data.export_id);
    expect((exp[0] as { manifest: unknown }).manifest).not.toBeNull();

    // --- tool_call persisted (C2) ---
    const { rows: tc } = await pool.query(`SELECT id, tenant_id, tool_name FROM tool_calls`);
    expect(tc).toHaveLength(1);
    expect(tc[0]).toMatchObject({ id: env.citations.tool_call_id, tenant_id: TENANT, tool_name: 'export_close_pack' });
  });

  it('rejects a malformed or impossible month with INVALID_INPUT (not opaque INTERNAL)', async () => {
    await seedWorld();
    await expect(exportClosePack(ctx(), { month: '2026-6', valuation: { currency: 'USD' } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    // Impossible month (13) must fail cleanly at the schema, not flow into date math.
    await expect(exportClosePack(ctx(), { month: '2026-13', valuation: { currency: 'USD' } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});

describe('export_pdf_summary', () => {
  it('writes a PDF + manifest and registers a pdf_summary export', async () => {
    await seedWorld();
    const env = await exportPdfSummary(ctx(), { month: MONTH, valuation: { currency: 'USD' }, out_dir: outDir });

    expect(env.data.kind).toBe('pdf_summary');
    expect(env.data.files.map((f) => f.name)).toEqual(['summary.pdf', 'manifest.json']);

    const pdfPath = env.data.files.find((f) => f.name === 'summary.pdf')!.path;
    const pdf = await readFile(pdfPath);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(sha256File(pdf)).toBe(env.data.files.find((f) => f.name === 'summary.pdf')!.sha256);

    const { rows } = await pool.query(`SELECT kind, status FROM exports`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'pdf_summary', status: 'done' });
  });
});

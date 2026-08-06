import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { exportJournalDrafts } from '../src/tools/export-journal-drafts.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;
let outDir: string;

const TENANT = '00000000-0000-0000-0000-000000000001';
const TENANT2 = '00000000-0000-0000-0000-000000000002';
const CLIENT = '00000000-0000-0000-0000-0000000000c1';
const CLIENT2 = '00000000-0000-0000-0000-0000000000c2';
const MISSING_CLIENT = '00000000-0000-0000-0000-0000000000cf';

const WALLET = `0x${'1'.repeat(40)}`;
const WALLET2 = `0x${'3'.repeat(40)}`;
const OUTSIDER = `0x${'9'.repeat(40)}`;
const PAYER = `0x${'2'.repeat(40)}`;
const EUR_TOKEN = `0x${'c'.repeat(40)}`;

const PERIOD = { from: '2026-06-01', to: '2026-06-30' };
const MAPPING = { crypto_asset: '1010', accounts_receivable: '1100', accounts_payable: '2000', vat_output: '2200', vat_input: '1300' };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
  outDir = await mkdtemp(join(tmpdir(), 'reconcil-journal-'));
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
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'acme')`, [TENANT]);
  await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Client One')`, [CLIENT, TENANT]);
  await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Client Two')`, [CLIENT2, TENANT]);
  await pool.query(`INSERT INTO wallets (tenant_id, client_id, address) VALUES ($1, $2, $3)`, [TENANT, CLIENT, WALLET]);
  await pool.query(`INSERT INTO wallets (tenant_id, client_id, address) VALUES ($1, $2, $3)`, [TENANT, CLIENT2, WALLET2]);
});

const ctx = (tenantId = TENANT): ToolContext => ({ db, tenantId });

async function seedToken(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tokens (chain_id, address, standard, symbol_display, decimals, is_stablecoin, peg_currency, verified)
     VALUES (1, $1, 'erc20', 'EURC', 6, true, 'EUR', true) RETURNING id`,
    [EUR_TOKEN],
  );
  return Number(rows[0]!.id);
}

interface EventOpts { logIndex?: number; from?: string; to?: string; blockTime?: string }
async function seedEvent(tokenId: number, amountRaw: string, opts: EventOpts = {}): Promise<number> {
  const { logIndex = 0, from = PAYER, to = WALLET, blockTime = '2026-06-14T10:00:00Z' } = opts;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO chain_events
       (chain_id, tx_hash, log_index, event_kind, token_id, amount_raw, from_addr, to_addr, block_number, block_time, tx_from, provider, raw)
     VALUES (1, $1, $2, 'erc20_transfer', $3, $4, $5, $6, 100, $7, $5, 'test', '{}'::jsonb) RETURNING id`,
    [`0x${logIndex.toString().padStart(64, 'a')}`, logIndex, tokenId, amountRaw, from, to, blockTime],
  );
  return Number(rows[0]!.id);
}

interface RecordOpts {
  direction?: 'receivable' | 'payable'; currency?: string; vatRate?: number | null;
  counterparty?: string; clientId?: string | null; status?: string;
}
async function seedRecord(externalRef: string, amount: string, opts: RecordOpts = {}): Promise<string> {
  const { direction = 'receivable', currency = 'EUR', vatRate = null, counterparty = null, clientId = CLIENT, status = 'matched' } = opts;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO external_records
       (tenant_id, client_id, kind, direction, source, external_ref, counterparty_name, amount, currency, vat_rate, issued_on, status)
     VALUES ($1, $2, 'invoice', $3, 'csv', $4, $5, $6, $7, $8, '2026-06-01', $9) RETURNING id`,
    [TENANT, clientId, direction, externalRef, counterparty, amount, currency, vatRate, status],
  );
  return rows[0]!.id;
}

async function seedLeg(
  recordId: string, eventId: number, amountAppliedRaw: string, fiatValue: string,
  opts: { status?: 'confirmed' | 'suggested' | 'rejected'; currency?: string } = {},
): Promise<string> {
  const { status = 'confirmed', currency = 'EUR' } = opts;
  const confirmed = status === 'confirmed';
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO matches
       (tenant_id, external_record_id, chain_event_id, amount_applied_raw, fiat_value, fiat_currency, status, matched_by, confirmed_by, confirmed_at, confidence, rationale)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent', $8, $9, 0.9, '{}'::jsonb) RETURNING id`,
    [TENANT, recordId, eventId, amountAppliedRaw, fiatValue, currency, status, confirmed ? 'agent' : null, confirmed ? new Date() : null],
  );
  return rows[0]!.id;
}

function sha256File(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('export_journal_drafts — recon-backed journal materialization (§6.5)', () => {
  it('journalizes confirmed legs (receivable + payable, VAT split), writes the file, registers the export, persists the tool_call', async () => {
    const token = await seedToken();
    // Receivable settled: 1000 EUR @21% VAT.
    const inv = await seedRecord('INV-1', '1000.00', { direction: 'receivable', vatRate: 21, counterparty: 'ACME' });
    const evIn = await seedEvent(token, '1000000000', { logIndex: 1, to: WALLET });
    await seedLeg(inv, evIn, '1000000000', '1000.00');
    // Payable settled: 1210 EUR @21% VAT (outbound).
    const bill = await seedRecord('BILL-1', '1210.00', { direction: 'payable', vatRate: 21, counterparty: 'Vendor' });
    const evOut = await seedEvent(token, '1210000000', { logIndex: 2, from: WALLET, to: OUTSIDER });
    await seedLeg(bill, evOut, '1210000000', '1210.00');
    // A SUGGESTED leg must never reach an export (P8).
    const draftRec = await seedRecord('INV-SUGGESTED', '500.00', { direction: 'receivable' });
    const evSug = await seedEvent(token, '500000000', { logIndex: 3, to: WALLET });
    await seedLeg(draftRec, evSug, '500000000', '500.00', { status: 'suggested' });

    const env = await exportJournalDrafts(ctx(), { period: PERIOD, target: 'qbo', account_mapping: MAPPING, out_dir: outDir });

    // --- output shape ---
    expect(env.data.balanced).toBe(true);
    expect(env.data.lines).toBe(6); // 3 + 3
    expect(env.data.unmapped_categories).toEqual([]);
    expect(env.data.export_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.data.file.name).toBe('journal_draft_qbo_2026-06_DRAFT.csv');

    // --- file on disk, hash matches, DRAFT + VAT split present, suggested excluded ---
    const buf = await readFile(env.data.file.path);
    expect(sha256File(buf)).toBe(env.data.file.sha256);
    const csv = buf.toString('utf8');
    expect(csv).toContain('DRAFT — REVIEW REQUIRED');
    expect(csv).toContain('1010,1000.00,0.00,INV-1 — ACME,EUR'); // asset debit, receivable
    expect(csv).toContain('1100,0.00,826.45,INV-1 — ACME,EUR'); // net receivable
    expect(csv).toContain('2200,0.00,173.55,INV-1 — ACME,EUR'); // output VAT
    expect(csv).toContain('1010,0.00,1210.00,BILL-1 — Vendor,EUR'); // asset credit, payable
    expect(csv).not.toContain('INV-SUGGESTED');

    // --- exports row (journal_qbo) + manifest ---
    const { rows: exp } = await pool.query(
      `SELECT status, kind, tenant_id, period_start::text AS period_start, period_end::text AS period_end, manifest FROM exports`,
    );
    expect(exp).toHaveLength(1);
    expect(exp[0]).toMatchObject({ status: 'done', kind: 'journal_qbo', tenant_id: TENANT, period_start: '2026-06-01', period_end: '2026-06-30' });
    expect((exp[0] as { manifest: { lines: number; draft: boolean } }).manifest.draft).toBe(true);

    // --- tool_call persisted (C2) ---
    const { rows: tc } = await pool.query(`SELECT id, tenant_id, tool_name FROM tool_calls`);
    expect(tc).toHaveLength(1);
    expect(tc[0]).toMatchObject({ id: env.citations.tool_call_id, tenant_id: TENANT, tool_name: 'export_journal_drafts' });
  });

  it('reports categories that account_mapping did not cover', async () => {
    const token = await seedToken();
    const inv = await seedRecord('INV-2', '1000.00', { direction: 'receivable', vatRate: 21 });
    const ev = await seedEvent(token, '1000000000', { logIndex: 1 });
    await seedLeg(inv, ev, '1000000000', '1000.00');

    const env = await exportJournalDrafts(ctx(), { period: PERIOD, target: 'xero', account_mapping: { crypto_asset: '1010' }, out_dir: outDir });

    expect(env.data.unmapped_categories).toEqual(['accounts_receivable', 'vat_output']);
    expect(env.data.file.name).toBe('journal_draft_xero_2026-06_DRAFT.csv');
  });

  it('filters confirmed legs by the settlement block_time period', async () => {
    const token = await seedToken();
    const jun = await seedRecord('INV-JUN', '100.00', { direction: 'receivable' });
    const aug = await seedRecord('INV-AUG', '100.00', { direction: 'receivable' });
    const evJun = await seedEvent(token, '100000000', { logIndex: 1, blockTime: '2026-06-14T10:00:00Z' });
    const evAug = await seedEvent(token, '100000000', { logIndex: 2, blockTime: '2026-08-14T10:00:00Z' });
    await seedLeg(jun, evJun, '100000000', '100.00');
    await seedLeg(aug, evAug, '100000000', '100.00');

    const env = await exportJournalDrafts(ctx(), { period: PERIOD, target: 'qbo', account_mapping: MAPPING, out_dir: outDir });

    expect(env.data.lines).toBe(2); // only the June entry (no VAT → 2 lines)
    const csv = (await readFile(env.data.file.path)).toString('utf8');
    expect(csv).toContain('INV-JUN');
    expect(csv).not.toContain('INV-AUG');
  });

  it('scopes to a client and surfaces coverage staleness (C5)', async () => {
    const token = await seedToken();
    const c1 = await seedRecord('INV-C1', '100.00', { direction: 'receivable', clientId: CLIENT });
    const c2 = await seedRecord('INV-C2', '200.00', { direction: 'receivable', clientId: CLIENT2 });
    const ev1 = await seedEvent(token, '100000000', { logIndex: 1, to: WALLET });
    const ev2 = await seedEvent(token, '200000000', { logIndex: 2, to: WALLET2 });
    await seedLeg(c1, ev1, '100000000', '100.00');
    await seedLeg(c2, ev2, '200000000', '200.00');
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status) VALUES (1, $1, 'erc20', 'backfilling')`,
      [WALLET],
    );

    const env = await exportJournalDrafts(ctx(), { period: PERIOD, target: 'qbo', client_id: CLIENT, account_mapping: MAPPING, out_dir: outDir });

    expect(env.data.lines).toBe(2); // only CLIENT's receivable
    const csv = (await readFile(env.data.file.path)).toString('utf8');
    expect(csv).toContain('INV-C1');
    expect(csv).not.toContain('INV-C2');
    expect(env.citations.coverage.length).toBeGreaterThan(0);
    expect(env.warnings).toContainEqual(expect.objectContaining({ code: 'COVERAGE_INCOMPLETE' }));
  });

  it('rejects an unknown client_id with INVALID_INPUT', async () => {
    await expect(
      exportJournalDrafts(ctx(), { period: PERIOD, target: 'qbo', client_id: MISSING_CLIENT, out_dir: outDir }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('produces an empty but balanced journal when nothing is confirmed in the period', async () => {
    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'empty', 'empty')`, [TENANT2]);
    const env = await exportJournalDrafts(ctx(TENANT2), { period: PERIOD, target: 'qbo', out_dir: outDir });
    expect(env.data.balanced).toBe(true);
    expect(env.data.lines).toBe(0);
  });
});

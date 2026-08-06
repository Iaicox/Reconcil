import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { ToolError } from '../src/errors.js';
import { reconImportInvoices } from '../src/tools/recon-import-invoices.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const TENANT = '00000000-0000-0000-0000-000000000001';
const TENANT2 = '00000000-0000-0000-0000-000000000002';
const CLIENT = '00000000-0000-0000-0000-0000000000c1';
const CLIENT2 = '00000000-0000-0000-0000-0000000000c2';

const CSV = [
  'invoice,customer,amount,currency,issued_on',
  'INV-001,Acme GmbH,1000.00,EUR,2026-06-01',
  'INV-002,=SUM(A1:A9),500.00,EUR,2026-06-05', // formula-lead hostile name
  'INV-003,BadRow,notanumber,EUR,2026-06-06', // invalid amount → row error
].join('\n');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => {
  delete process.env.RECONCIL_IMPORT_DIR;
  delete process.env.RECONCIL_IMPORT_MAX_BYTES;
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  delete process.env.RECONCIL_IMPORT_DIR;
  delete process.env.RECONCIL_IMPORT_MAX_BYTES;
  await pool.query('TRUNCATE tenants, clients, external_records, tool_calls RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'acme')`, [TENANT]);
});

const ctx = (): ToolContext => ({ db, tenantId: TENANT });

describe('recon_import_invoices — import, sanitization, audit', () => {
  it('inserts valid rows, reports bad rows, and sanitizes hostile names only at the edge', async () => {
    const env = await reconImportInvoices(ctx(), { format: 'csv', content: CSV });

    expect(env.data.inserted).toBe(2);
    expect(env.data.skipped_duplicates).toBe(0);
    expect(env.data.errors).toEqual([{ row: 3, code: 'INVALID_AMOUNT', message: expect.any(String) as unknown }]);
    expect(env.data.records.map((r) => r.external_ref).sort()).toEqual(['INV-001', 'INV-002']);

    // C6: the formula-lead name ships only sanitized, under `untrusted`.
    const inv2 = env.data.records.find((r) => r.external_ref === 'INV-002');
    expect(inv2?.untrusted?.counterparty_name).toBeDefined();
    expect(inv2?.untrusted?.counterparty_name).not.toContain('=');

    // ...but the DB keeps the RAW hostile string for audit (never leaves the server).
    const { rows } = await pool.query<{ counterparty_name: string; payload: { customer: string } }>(
      `SELECT counterparty_name, payload FROM external_records WHERE external_ref = 'INV-002'`,
    );
    expect(rows[0]?.counterparty_name).toBe('=SUM(A1:A9)');
    expect(rows[0]?.payload.customer).toBe('=SUM(A1:A9)');

    // C2: tool_call persisted before responding, with the bulky content redacted.
    const tc = await pool.query<{ tool_name: string; args: { content: string; format: string } }>(
      `SELECT tool_name, args FROM tool_calls`,
    );
    expect(tc.rows).toHaveLength(1);
    expect(tc.rows[0]?.tool_name).toBe('recon_import_invoices');
    expect(tc.rows[0]?.args.content).toMatch(/chars omitted/);
    expect(env.citations.tool_call_id).toBeTruthy();
  });

  it('is idempotent: re-importing the same CSV skips existing refs and inserts nothing', async () => {
    await reconImportInvoices(ctx(), { format: 'csv', content: CSV });
    const again = await reconImportInvoices(ctx(), { format: 'csv', content: CSV });

    expect(again.data.inserted).toBe(0);
    expect(again.data.skipped_duplicates).toBe(2);

    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM external_records`);
    expect(rows[0]?.n).toBe('2'); // still only the two originals
  });

  it('collapses in-file duplicate refs (first row wins) and counts them skipped', async () => {
    const dupCsv = 'invoice,amount,currency\nINV-1,10.00,EUR\nINV-1,99.00,EUR';
    const env = await reconImportInvoices(ctx(), { format: 'csv', content: dupCsv });
    expect(env.data.inserted).toBe(1);
    expect(env.data.skipped_duplicates).toBe(1);
    const { rows } = await pool.query<{ amount: string }>(`SELECT amount FROM external_records`);
    expect(rows[0]?.amount).toBe('10.00'); // the first occurrence was kept
  });

  it('attaches an owned client and rejects a client from another tenant', async () => {
    await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Client One')`, [CLIENT, TENANT]);
    const ok = await reconImportInvoices(ctx(), { format: 'csv', content: CSV, client_id: CLIENT });
    expect(ok.data.inserted).toBe(2);

    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'other', 'other')`, [TENANT2]);
    await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Foreign')`, [CLIENT2, TENANT2]);
    await expect(
      reconImportInvoices(ctx(), { format: 'csv', content: CSV, client_id: CLIENT2 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('returns file-level errors without throwing when a required column is missing', async () => {
    const env = await reconImportInvoices(ctx(), { format: 'csv', content: 'customer,amount\nAcme,10.00' });
    expect(env.data.inserted).toBe(0);
    expect(env.data.records).toEqual([]);
    expect(env.data.errors.map((e) => e.code)).toContain('NO_CURRENCY_COLUMN');
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    // both content and file_path → violates "exactly one"
    await expect(
      reconImportInvoices(ctx(), { format: 'csv', content: CSV, file_path: '/tmp/x.csv' }),
    ).rejects.toBeInstanceOf(ToolError);
    await expect(reconImportInvoices(ctx(), { bogus: 1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a non-UUID client_id with INVALID_INPUT (not a raw uuid-cast error)', async () => {
    await expect(
      reconImportInvoices(ctx(), { format: 'csv', content: CSV, client_id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a negative vat_rate default at input validation', async () => {
    await expect(
      reconImportInvoices(ctx(), { format: 'csv', content: CSV, defaults: { vat_rate: -5 } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('recon_import_invoices — file_path confinement & caps (security)', () => {
  const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'recon-import-'));

  it('reads a file confined to RECONCIL_IMPORT_DIR', async () => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir, 'acme.csv'), CSV);
      process.env.RECONCIL_IMPORT_DIR = dir;
      const env = await reconImportInvoices(ctx(), { format: 'csv', file_path: 'acme.csv' });
      expect(env.data.inserted).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a traversal file_path without leaking the path, and inserts nothing', async () => {
    const dir = await tempDir();
    try {
      process.env.RECONCIL_IMPORT_DIR = dir;
      let thrown: ToolError | undefined;
      try {
        await reconImportInvoices(ctx(), { format: 'csv', file_path: '../../../../etc/passwd' });
      } catch (err) {
        thrown = err as ToolError;
      }
      expect(thrown?.code).toBe('INVALID_INPUT');
      expect(thrown?.message).not.toContain(dir); // no base path leaked (finding 3)
      expect(thrown?.message).not.toContain('passwd'); // no target path leaked
      const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM external_records`);
      expect(rows[0]?.n).toBe('0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is fail-closed when RECONCIL_IMPORT_DIR is unset', async () => {
    // beforeEach cleared the env var
    await expect(
      reconImportInvoices(ctx(), { format: 'csv', file_path: 'anything.csv' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an oversized file (RECONCIL_IMPORT_MAX_BYTES)', async () => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir, 'big.csv'), 'invoice,amount,currency\nINV-1,10.00,EUR\n');
      process.env.RECONCIL_IMPORT_DIR = dir;
      process.env.RECONCIL_IMPORT_MAX_BYTES = '10';
      await expect(
        reconImportInvoices(ctx(), { format: 'csv', file_path: 'big.csv' }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects >1 MB inline content by byte length (multibyte, under the char cap)', async () => {
    // 400k × 3-byte '€' = 1.2 MB but only 400k chars (< the schema char pre-filter),
    // so this exercises the handler's byte-accurate cap specifically.
    const big = '€'.repeat(400_000);
    await expect(
      reconImportInvoices(ctx(), { format: 'csv', content: big }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { reconSuggestMatches } from '../src/tools/recon-suggest-matches.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const TENANT = '00000000-0000-0000-0000-000000000001';
const TENANT2 = '00000000-0000-0000-0000-000000000002';
const CLIENT = '00000000-0000-0000-0000-0000000000c1';

const WALLET = `0x${'1'.repeat(40)}`; // tenant's receiving wallet
const PAYER = `0x${'2'.repeat(40)}`; // counterparty (invoice expected_address)
const STRANGER = `0x${'3'.repeat(40)}`; // unrelated sender
const TOKEN_ADDR = `0x${'c'.repeat(40)}`; // EUR-pegged stablecoin

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
  await pool.query(
    'TRUNCATE tenants, clients, wallets, tokens, chain_events, external_records, matches, tool_calls RESTART IDENTITY CASCADE',
  );
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'acme')`, [TENANT]);
  await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Client One')`, [CLIENT, TENANT]);
  await pool.query(`INSERT INTO wallets (tenant_id, client_id, address) VALUES ($1, $2, $3)`, [TENANT, CLIENT, WALLET]);
});

const ctx = (tenantId = TENANT): ToolContext => ({ db, tenantId });

/** A verified EUR-pegged stablecoin (6 decimals). Returns its token id. */
async function seedToken(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tokens (chain_id, address, standard, symbol_display, decimals, is_stablecoin, peg_currency, verified)
     VALUES (1, $1, 'erc20', 'EURC', 6, true, 'EUR', true) RETURNING id`,
    [TOKEN_ADDR],
  );
  return Number(rows[0]!.id);
}

/** A stablecoin transfer `from → to` of `amountRaw` base units at `blockTime`. */
async function seedEvent(
  tokenId: number,
  from: string,
  to: string,
  amountRaw: string,
  blockTime: string,
  logIndex = 0,
): Promise<void> {
  await pool.query(
    `INSERT INTO chain_events
       (chain_id, tx_hash, log_index, event_kind, token_id, amount_raw, from_addr, to_addr, block_number, block_time, tx_from, provider, raw)
     VALUES (1, $1, $2, 'erc20_transfer', $3, $4, $5, $6, 100, $7, $5, 'test', '{}'::jsonb)`,
    [`0x${logIndex.toString().padStart(64, 'a')}`, logIndex, tokenId, amountRaw, from, to, blockTime],
  );
}

/** An open EUR receivable invoice. Returns its record id. */
async function seedInvoice(externalRef: string, amount: string, expectedAddress: string | null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO external_records
       (tenant_id, client_id, kind, direction, source, external_ref, amount, currency, issued_on, due_on, expected_address, status)
     VALUES ($1, $2, 'invoice', 'receivable', 'csv', $3, $4, 'EUR', '2026-06-01', '2026-06-15', $5, 'open') RETURNING id`,
    [TENANT, CLIENT, externalRef, amount, expectedAddress],
  );
  return rows[0]!.id;
}

describe('recon_suggest_matches — engine run, persistence, audit', () => {
  it('suggests a confident match, persists it as suggested/auto, and cites the event', async () => {
    const tokenId = await seedToken();
    await seedEvent(tokenId, PAYER, WALLET, '1000000000', '2026-06-14T10:00:00Z'); // 1000.00 EURC
    await seedInvoice('INV-100', '1000.00', PAYER);

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions).toHaveLength(1);
    const s = env.data.suggestions[0]!;
    expect(s.record.external_ref).toBe('INV-100');
    expect(s.record.open_amount).toBe('1000');
    expect(s.event.from.address).toBe(PAYER);
    expect(s.amount_applied).toBe('1000');
    expect(s.confidence).toBeGreaterThan(0.8);
    expect(s.rationale.map((r) => r.rule).sort()).toEqual(['address', 'amount', 'date']);
    expect(env.data.unmatched_records).toBe(0);
    expect(env.data.unmatched_settlements).toBe(0);

    // Persisted as a suggested/auto leg with the whole event applied (base units).
    const { rows } = await pool.query<{ status: string; matched_by: string; amount_applied_raw: string; confidence: string }>(
      `SELECT status, matched_by, amount_applied_raw, confidence FROM matches`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('suggested');
    expect(rows[0]!.matched_by).toBe('auto');
    expect(rows[0]!.amount_applied_raw).toBe('1000000000');
    expect(Number(rows[0]!.confidence)).toBeGreaterThan(0.8);

    // C2: the tool_call is persisted before responding, and the event is cited.
    const tc = await pool.query<{ tool_name: string }>(`SELECT tool_name FROM tool_calls`);
    expect(tc.rows).toHaveLength(1);
    expect(tc.rows[0]!.tool_name).toBe('recon_suggest_matches');
    expect(env.citations.tool_call_id).toBeTruthy();
    expect(env.citations.event_refs).toHaveLength(1);
  });

  it('is idempotent: a re-run replaces suggested legs but never touches confirmed ones', async () => {
    const tokenId = await seedToken();
    await seedEvent(tokenId, PAYER, WALLET, '1000000000', '2026-06-14T10:00:00Z');
    await seedInvoice('INV-100', '1000.00', PAYER);

    await reconSuggestMatches(ctx(), {});
    // A human confirms the suggestion.
    await pool.query(`UPDATE matches SET status = 'confirmed'`);

    await reconSuggestMatches(ctx(), {});

    // The confirmed leg survives the re-run.
    const confirmed = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM matches WHERE status = 'confirmed'`);
    expect(confirmed.rows[0]!.n).toBe('1');
  });

  it('isolates tenants: another tenant sees nothing and leaves the first tenant’s matches intact', async () => {
    const tokenId = await seedToken();
    await seedEvent(tokenId, PAYER, WALLET, '1000000000', '2026-06-14T10:00:00Z');
    await seedInvoice('INV-100', '1000.00', PAYER);
    await reconSuggestMatches(ctx(), {});

    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'other', 'other')`, [TENANT2]);
    const env = await reconSuggestMatches(ctx(TENANT2), {});
    expect(env.data.suggestions).toEqual([]);

    const total = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM matches`);
    expect(total.rows[0]!.n).toBe('1'); // only the first tenant's leg
  });

  it('reports unmatched records and unmatched settlements', async () => {
    const tokenId = await seedToken();
    await seedEvent(tokenId, PAYER, WALLET, '1000000000', '2026-06-14T10:00:00Z'); // settles INV-100
    await seedEvent(tokenId, STRANGER, WALLET, '777000000', '2026-06-14T11:00:00Z', 1); // no record wants it
    await seedInvoice('INV-100', '1000.00', PAYER);
    await seedInvoice('INV-200', '500.00', null); // no matching event/sender

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions.map((s) => s.record.external_ref)).toEqual(['INV-100']);
    expect(env.data.unmatched_records).toBe(1); // INV-200
    expect(env.data.unmatched_settlements).toBe(1); // the 777.00 transfer from a stranger
  });
});

import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { reconConfirmMatch } from '../src/tools/recon-confirm-match.js';
import { reconRejectMatch } from '../src/tools/recon-reject-match.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const TENANT = '00000000-0000-0000-0000-000000000001';
const TENANT2 = '00000000-0000-0000-0000-000000000002';
const CLIENT = '00000000-0000-0000-0000-0000000000c1';

const WALLET = `0x${'1'.repeat(40)}`; // tenant's receiving wallet
const PAYER = `0x${'2'.repeat(40)}`; // counterparty on a receivable

const TOKEN_ADDR = `0x${'c'.repeat(40)}`; // EUR-pegged stablecoin
// Well-formed (passes the schema's `.uuid()` shape check) but absent from `matches`,
// so this still exercises the repo's "not found" lookup, not schema-level rejection.
const MISSING_MATCH = '00000000-0000-4000-8000-0000000000ff';

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

/** A stablecoin transfer `from → to` of `amountRaw` base units. Returns the event id. */
async function seedEvent(
  tokenId: number,
  amountRaw: string,
  logIndex = 0,
  from = PAYER,
  to = WALLET,
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO chain_events
       (chain_id, tx_hash, log_index, event_kind, token_id, amount_raw, from_addr, to_addr, block_number, block_time, tx_from, provider, raw)
     VALUES (1, $1, $2, 'erc20_transfer', $3, $4, $5, $6, 100, '2026-06-14T10:00:00Z', $5, 'test', '{}'::jsonb)
     RETURNING id`,
    [`0x${logIndex.toString().padStart(64, 'a')}`, logIndex, tokenId, amountRaw, from, to],
  );
  return Number(rows[0]!.id);
}

/** An open EUR receivable. Returns its record id. */
async function seedInvoice(externalRef: string, amount: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO external_records
       (tenant_id, client_id, kind, direction, source, external_ref, amount, currency, issued_on, due_on, expected_address, status)
     VALUES ($1, $2, 'invoice', 'receivable', 'csv', $3, $4, 'EUR', '2026-06-01', '2026-06-15', $5, 'open') RETURNING id`,
    [TENANT, CLIENT, externalRef, amount, PAYER],
  );
  return rows[0]!.id;
}

/** A suggested leg (bypasses the engine so edge amounts are exact). Returns the match id. */
async function seedSuggestedLeg(
  recordId: string,
  eventId: number,
  amountAppliedRaw: string,
  fiatValue: string,
  tenantId = TENANT,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO matches
       (tenant_id, external_record_id, chain_event_id, amount_applied_raw, fiat_value, fiat_currency, status, matched_by, confidence, rationale)
     VALUES ($1, $2, $3, $4, $5, 'EUR', 'suggested', 'auto', 0.9, '{}'::jsonb) RETURNING id`,
    [tenantId, recordId, eventId, amountAppliedRaw, fiatValue],
  );
  return rows[0]!.id;
}

const legStatus = async (matchId: string): Promise<string | undefined> =>
  (await pool.query<{ status: string }>(`SELECT status FROM matches WHERE id = $1`, [matchId])).rows[0]?.status;

const recordStatus = async (recordId: string): Promise<string | undefined> =>
  (await pool.query<{ status: string }>(`SELECT status FROM external_records WHERE id = $1`, [recordId])).rows[0]?.status;

describe('recon_confirm_match — HITL confirmation', () => {
  it('confirms a suggested leg: flips to confirmed with an audit stamp and matches the record', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1000000000'); // 1000.00 EURC
    const recId = await seedInvoice('INV-100', '1000.00');
    const matchId = await seedSuggestedLeg(recId, eventId, '1000000000', '1000.00');

    const env = await reconConfirmMatch(ctx(), { match_id: matchId });

    expect(env.data.match_id).toBe(matchId);
    expect(env.data.status).toBe('confirmed');
    expect(env.data.record_status).toBe('matched');
    expect(env.data.valuation.fiat_value).toBe('1000.00');
    expect(env.citations.coverage).toEqual([]);

    // Leg persisted with the who/when audit stamp.
    const { rows } = await pool.query<{ status: string; confirmed_by: string; confirmed_at: string | null }>(
      `SELECT status, confirmed_by, confirmed_at FROM matches WHERE id = $1`,
      [matchId],
    );
    expect(rows[0]!.status).toBe('confirmed');
    expect(rows[0]!.confirmed_by).toBe('agent');
    expect(rows[0]!.confirmed_at).not.toBeNull();

    expect(await recordStatus(recId)).toBe('matched');

    // C2: tool_call persisted before responding.
    const tc = await pool.query<{ tool_name: string }>(`SELECT tool_name FROM tool_calls`);
    expect(tc.rows[0]!.tool_name).toBe('recon_confirm_match');
    expect(env.citations.tool_call_id).toBeTruthy();
  });

  it('confirming a partial payment leaves the record partially_matched', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '400000000'); // 400.00 EURC
    const recId = await seedInvoice('INV-100', '1000.00');
    const matchId = await seedSuggestedLeg(recId, eventId, '400000000', '400.00');

    const env = await reconConfirmMatch(ctx(), { match_id: matchId });

    expect(env.data.record_status).toBe('partially_matched');
    expect(await recordStatus(recId)).toBe('partially_matched');
  });

  it('confirming beyond the invoice amount marks the record overpaid', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1500000000'); // 1500.00 EURC
    const recId = await seedInvoice('INV-100', '1000.00');
    const matchId = await seedSuggestedLeg(recId, eventId, '1500000000', '1500.00');

    const env = await reconConfirmMatch(ctx(), { match_id: matchId });

    expect(env.data.record_status).toBe('overpaid');
    expect(await recordStatus(recId)).toBe('overpaid');
  });

  it('rejects a second confirm on the same leg with NOT_SUGGESTED and leaves it confirmed', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1000000000');
    const recId = await seedInvoice('INV-100', '1000.00');
    const matchId = await seedSuggestedLeg(recId, eventId, '1000000000', '1000.00');

    await reconConfirmMatch(ctx(), { match_id: matchId });
    await expect(reconConfirmMatch(ctx(), { match_id: matchId })).rejects.toMatchObject({ code: 'NOT_SUGGESTED' });
    expect(await legStatus(matchId)).toBe('confirmed');
  });

  it('raises MATCH_CONFLICT when a second confirm would over-apply the event', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1000000000'); // one 1000.00 settlement
    const recA = await seedInvoice('INV-A', '1000.00');
    const recB = await seedInvoice('INV-B', '1000.00');
    const legA = await seedSuggestedLeg(recA, eventId, '1000000000', '1000.00');
    const legB = await seedSuggestedLeg(recB, eventId, '1000000000', '1000.00');

    await reconConfirmMatch(ctx(), { match_id: legA }); // fully applies the event
    await expect(reconConfirmMatch(ctx(), { match_id: legB })).rejects.toMatchObject({ code: 'MATCH_CONFLICT' });

    // The first leg stays confirmed; the conflicting one stays suggested (tx rolled back).
    expect(await legStatus(legA)).toBe('confirmed');
    expect(await legStatus(legB)).toBe('suggested');
    expect(await recordStatus(recB)).toBe('open');
  });

  it('rejects an unknown match_id with INVALID_INPUT', async () => {
    await expect(reconConfirmMatch(ctx(), { match_id: MISSING_MATCH })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects a non-UUID match_id with INVALID_INPUT at input validation (not a raw uuid-cast error)', async () => {
    await expect(reconConfirmMatch(ctx(), { match_id: 'not-a-uuid' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(reconRejectMatch(ctx(), { match_id: 'not-a-uuid' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('isolates tenants: a foreign tenant cannot confirm the leg (INVALID_INPUT), leaving it suggested', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1000000000');
    const recId = await seedInvoice('INV-100', '1000.00');
    const matchId = await seedSuggestedLeg(recId, eventId, '1000000000', '1000.00');

    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'other', 'other')`, [TENANT2]);
    await expect(reconConfirmMatch(ctx(TENANT2), { match_id: matchId })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await legStatus(matchId)).toBe('suggested');
  });
});

describe('recon_reject_match — HITL rejection', () => {
  it('rejects a suggested leg and leaves the record status unchanged', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1000000000');
    const recId = await seedInvoice('INV-100', '1000.00');
    const matchId = await seedSuggestedLeg(recId, eventId, '1000000000', '1000.00');

    const env = await reconRejectMatch(ctx(), { match_id: matchId, note: 'wrong sender' });

    expect(env.data.status).toBe('rejected');
    expect(env.data.record_status).toBe('open'); // no confirmed legs → still open
    expect(await legStatus(matchId)).toBe('rejected');
    expect(await recordStatus(recId)).toBe('open');

    const tc = await pool.query<{ tool_name: string }>(`SELECT tool_name FROM tool_calls`);
    expect(tc.rows[0]!.tool_name).toBe('recon_reject_match');
  });

  it('a rejected leg does not count toward the confirmed total: the event stays available', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1000000000');
    const recA = await seedInvoice('INV-A', '1000.00');
    const recB = await seedInvoice('INV-B', '1000.00');
    const legA = await seedSuggestedLeg(recA, eventId, '1000000000', '1000.00');
    const legB = await seedSuggestedLeg(recB, eventId, '1000000000', '1000.00');

    await reconRejectMatch(ctx(), { match_id: legA }); // frees the event
    await reconConfirmMatch(ctx(), { match_id: legB }); // now confirmable without conflict

    expect(await legStatus(legB)).toBe('confirmed');
    expect(await recordStatus(recB)).toBe('matched');
  });

  it('rejects confirm/reject on an already-rejected leg with NOT_SUGGESTED', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1000000000');
    const recId = await seedInvoice('INV-100', '1000.00');
    const matchId = await seedSuggestedLeg(recId, eventId, '1000000000', '1000.00');

    await reconRejectMatch(ctx(), { match_id: matchId });
    await expect(reconRejectMatch(ctx(), { match_id: matchId })).rejects.toMatchObject({ code: 'NOT_SUGGESTED' });
    await expect(reconConfirmMatch(ctx(), { match_id: matchId })).rejects.toMatchObject({ code: 'NOT_SUGGESTED' });
  });
});

describe('void parent record — terminal, not actionable', () => {
  it('refuses to confirm or reject a leg whose record was voided, leaving the leg suggested', async () => {
    const tokenId = await seedToken();
    const eventId = await seedEvent(tokenId, '1000000000');
    const recId = await seedInvoice('INV-100', '1000.00');
    const matchId = await seedSuggestedLeg(recId, eventId, '1000000000', '1000.00');
    await pool.query(`UPDATE external_records SET status = 'void' WHERE id = $1`, [recId]);

    // A void record can't be represented in the output's record_status enum, and its
    // status must never be resurrected — both decisions are refused up front.
    await expect(reconConfirmMatch(ctx(), { match_id: matchId })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(reconRejectMatch(ctx(), { match_id: matchId })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(await legStatus(matchId)).toBe('suggested'); // untouched
    expect(await recordStatus(recId)).toBe('void'); // still terminal
  });
});

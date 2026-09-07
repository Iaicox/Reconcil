import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { reconConfirmMatch } from '../src/tools/recon-confirm-match.js';
import { reconSuggestMatches } from '../src/tools/recon-suggest-matches.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const TENANT = '00000000-0000-0000-0000-000000000001';
const TENANT2 = '00000000-0000-0000-0000-000000000002';
const CLIENT = '00000000-0000-0000-0000-0000000000c1';

const WALLET = `0x${'1'.repeat(40)}`; // tenant's receiving/paying wallet
const PAYER = `0x${'2'.repeat(40)}`; // counterparty on a receivable (invoice expected_address)
const STRANGER = `0x${'3'.repeat(40)}`; // unrelated sender
const VENDOR = `0x${'4'.repeat(40)}`; // counterparty on a payable (payee)
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

const WETH_ADDR = `0x${'d'.repeat(40)}`; // a verified non-stablecoin (volatile) token

/** A verified NON-stablecoin ERC-20 (WETH-like, 18 decimals). Returns its token id. */
async function seedNonStableToken(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tokens (chain_id, address, standard, symbol_display, decimals, is_stablecoin, peg_currency, verified)
     VALUES (1, $1, 'erc20', 'WETH', 18, false, null, true) RETURNING id`,
    [WETH_ADDR],
  );
  return Number(rows[0]!.id);
}

/** A daily price snapshot for a token (defillama source by default). */
async function seedSnapshot(
  tokenId: number,
  price: string,
  date: string,
  currency = 'EUR',
  source = 'defillama',
): Promise<void> {
  await pool.query(
    `INSERT INTO price_snapshots (token_id, price_date, currency, price, source) VALUES ($1,$2,$3,$4,$5)`,
    [tokenId, date, currency, price, source],
  );
}

/** An ECB EUR→USD reference rate (rate = USD per 1 EUR). */
async function seedFx(date: string, rate: string): Promise<void> {
  await pool.query(
    `INSERT INTO fx_rates (rate_date, base_currency, quote_currency, rate, source) VALUES ($1,'EUR','USD',$2,'ecb')`,
    [date, rate],
  );
}

/** An open EUR external record. Returns its record id. */
async function seedInvoice(
  externalRef: string,
  amount: string,
  expectedAddress: string | null,
  direction: 'receivable' | 'payable' = 'receivable',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO external_records
       (tenant_id, client_id, kind, direction, source, external_ref, amount, currency, issued_on, due_on, expected_address, status)
     VALUES ($1, $2, 'invoice', $6, 'csv', $3, $4, 'EUR', '2026-06-01', '2026-06-15', $5, 'open') RETURNING id`,
    [TENANT, CLIENT, externalRef, amount, expectedAddress, direction],
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

  it('matches a payable on the payee (to) end, not the tenant wallet', async () => {
    const tokenId = await seedToken();
    // Outbound: the tenant pays the vendor. The counterparty is the `to` end.
    await seedEvent(tokenId, WALLET, VENDOR, '1000000000', '2026-06-14T10:00:00Z');
    await seedInvoice('BILL-1', '1000.00', VENDOR, 'payable');

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions).toHaveLength(1);
    const s = env.data.suggestions[0]!;
    expect(s.record.external_ref).toBe('BILL-1');
    // Address rule fired against the payee end → high confidence.
    expect(s.rationale.map((r) => r.rule)).toContain('address');
    expect(s.confidence).toBeGreaterThan(0.8);
    // The wire `from` is still the real on-chain sender (the tenant wallet).
    expect(s.event.from.address).toBe(WALLET);
  });

  it('a zero-value transfer from the expected sender does not poison the run', async () => {
    const tokenId = await seedToken();
    await seedEvent(tokenId, PAYER, WALLET, '1000000000', '2026-06-14T10:00:00Z'); // the real settlement
    await seedEvent(tokenId, PAYER, WALLET, '0', '2026-06-14T09:00:00Z', 1); // 0-value spam from the payer
    await seedInvoice('INV-100', '1000.00', PAYER);

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions).toHaveLength(1); // the valid one; the 0-value event is dropped
    expect(env.data.suggestions[0]!.amount_applied).toBe('1000');
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM matches`);
    expect(rows[0]!.n).toBe('1');
  });

  it('rejects a non-UUID record_ids element with INVALID_INPUT (not a raw uuid-cast error)', async () => {
    await expect(
      reconSuggestMatches(ctx(), { record_ids: ['not-a-uuid'] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('scopes the run to the given record_ids', async () => {
    const tokenId = await seedToken();
    await seedEvent(tokenId, PAYER, WALLET, '1000000000', '2026-06-14T10:00:00Z'); // settles INV-100
    // A different counterparty and amount so it is not an address- or amount-candidate
    // for INV-100 — the only way it could appear is if scoping failed to exclude INV-200.
    await seedEvent(tokenId, STRANGER, WALLET, '500000000', '2026-06-14T11:00:00Z', 1); // settles INV-200
    const recA = await seedInvoice('INV-100', '1000.00', PAYER);
    await seedInvoice('INV-200', '500.00', STRANGER);

    const env = await reconSuggestMatches(ctx(), { record_ids: [recA] });

    expect(env.data.suggestions.map((s) => s.record.external_ref)).toEqual(['INV-100']);
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

const WETH = (n: string): string => {
  // n whole WETH → 18-decimal base units, exact (n has ≤ 18 fractional digits).
  const [w, f = ''] = n.split('.');
  return `${w}${f.padEnd(18, '0')}`.replace(/^0+(?=\d)/, '');
};

describe('recon_suggest_matches — market valuation (non-stablecoin)', () => {
  it('values a volatile-token settlement via a pinned price snapshot and matches it', async () => {
    const tokenId = await seedNonStableToken();
    // 0.5 WETH @ 2000.00 EUR/WETH on the settlement date = 1000.00 EUR → settles INV-ETH.
    await seedSnapshot(tokenId, '2000.00', '2026-06-14', 'EUR');
    await seedEvent(tokenId, PAYER, WALLET, WETH('0.5'), '2026-06-14T10:00:00Z');
    await seedInvoice('INV-ETH', '1000.00', PAYER);

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions).toHaveLength(1);
    const s = env.data.suggestions[0]!;
    expect(s.record.external_ref).toBe('INV-ETH');
    expect(s.fiat_value).toBe('1000'); // 0.5 × 2000, exact decimal
    expect(s.confidence).toBeGreaterThan(0.8);

    // The leg pins the snapshot it was valued at (C4 "priced means pinned").
    const { rows } = await pool.query<{ price_snapshot_id: string | null; fx_rate_id: string | null; fiat_value: string }>(
      `SELECT price_snapshot_id, fx_rate_id, fiat_value FROM matches`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.price_snapshot_id).not.toBeNull();
    expect(rows[0]!.fx_rate_id).toBeNull(); // same-currency valuation, no FX
    expect(rows[0]!.fiat_value).toBe('1000');

    // The pinned snapshot is cited in the envelope.
    expect(env.citations.price_refs).toBeDefined();
    expect(env.citations.price_refs).toHaveLength(1);
    expect(env.citations.price_refs![0]!.currency).toBe('EUR');
    expect(env.citations.price_refs![0]!.price).toBe('2000.00');
  });

  it('leaves a record open (never interpolates) when no snapshot prices the token', async () => {
    const tokenId = await seedNonStableToken();
    // No snapshot on the settlement date → the candidate is PRICE_MISSING and cannot match.
    await seedEvent(tokenId, PAYER, WALLET, WETH('0.5'), '2026-06-14T10:00:00Z');
    await seedInvoice('INV-ETH', '1000.00', PAYER);

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions).toHaveLength(0);
    expect(env.data.unmatched_records).toBe(1);
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM matches`);
    expect(rows[0]!.n).toBe('0'); // no leg persisted
    expect(env.warnings.map((w) => w.code)).toContain('PRICE_MISSING');
  });

  it('values across currencies with a pinned FX rate (USD snapshot → EUR invoice)', async () => {
    const tokenId = await seedNonStableToken();
    // 0.5 WETH @ 2200.00 USD = 1100 USD; EUR→USD 1.10 ⇒ 1000.00 EUR → settles INV-ETH.
    await seedSnapshot(tokenId, '2200.00', '2026-06-14', 'USD');
    await seedFx('2026-06-14', '1.10');
    await seedEvent(tokenId, PAYER, WALLET, WETH('0.5'), '2026-06-14T10:00:00Z');
    await seedInvoice('INV-ETH', '1000.00', PAYER);

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions).toHaveLength(1);
    expect(env.data.suggestions[0]!.fiat_value).toBe('1000');

    const { rows } = await pool.query<{ price_snapshot_id: string | null; fx_rate_id: string | null }>(
      `SELECT price_snapshot_id, fx_rate_id FROM matches`,
    );
    expect(rows[0]!.price_snapshot_id).not.toBeNull();
    expect(rows[0]!.fx_rate_id).not.toBeNull(); // FX was applied → pinned

    expect(env.citations.price_refs).toHaveLength(1);
    expect(env.citations.fx_refs).toBeDefined();
    expect(env.citations.fx_refs).toHaveLength(1);
    expect(env.citations.fx_refs![0]!.rate).toBe('1.10');
  });

  it('carries the pinned refs through to recon_confirm_match (C4)', async () => {
    const tokenId = await seedNonStableToken();
    await seedSnapshot(tokenId, '2000.00', '2026-06-14', 'EUR');
    await seedEvent(tokenId, PAYER, WALLET, WETH('0.5'), '2026-06-14T10:00:00Z');
    await seedInvoice('INV-ETH', '1000.00', PAYER);

    const suggested = await reconSuggestMatches(ctx(), {});
    const matchId = suggested.data.suggestions[0]!.match_id;

    const confirmed = await reconConfirmMatch(ctx(), { match_id: matchId });

    expect(confirmed.data.status).toBe('confirmed');
    expect(confirmed.data.record_status).toBe('matched');
    expect(confirmed.data.valuation.fiat_value).toBe('1000');
    // The confirm output re-hydrates the pinned snapshot (was empty on the face-value path).
    expect(confirmed.data.valuation.price_ref).toBeDefined();
    expect(confirmed.data.valuation.price_ref!.currency).toBe('EUR');
    expect(confirmed.citations.price_refs).toHaveLength(1);
  });

  it('keeps the stablecoin face-value fast path (no snapshot needed, no refs pinned)', async () => {
    const tokenId = await seedToken(); // EUR-pegged stablecoin
    await seedEvent(tokenId, PAYER, WALLET, '1000000000', '2026-06-14T10:00:00Z'); // 1000.00 EURC
    await seedInvoice('INV-100', '1000.00', PAYER);

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions).toHaveLength(1);
    expect(env.data.suggestions[0]!.fiat_value).toBe('1000');
    const { rows } = await pool.query<{ price_snapshot_id: string | null; fx_rate_id: string | null }>(
      `SELECT price_snapshot_id, fx_rate_id FROM matches`,
    );
    expect(rows[0]!.price_snapshot_id).toBeNull(); // face value at peg needs no snapshot (P5)
    expect(rows[0]!.fx_rate_id).toBeNull();
    expect(env.citations.price_refs).toBeUndefined();
  });

  it('warns (never silently drops) when a record currency cannot be valued', async () => {
    const tokenId = await seedNonStableToken();
    await seedEvent(tokenId, PAYER, WALLET, WETH('0.5'), '2026-06-14T10:00:00Z');
    // external_records.currency has no DB CHECK, so a future non-validating writer could produce
    // a non-USD/EUR record; a non-stablecoin candidate can't be valued into it and must surface
    // a warning rather than drop silently (honest-open, ADR-007).
    await pool.query(
      `INSERT INTO external_records
         (tenant_id, client_id, kind, direction, source, external_ref, amount, currency, issued_on, due_on, expected_address, status)
       VALUES ($1, $2, 'invoice', 'receivable', 'csv', 'INV-GBP', '1000.00', 'GBP', '2026-06-01', '2026-06-15', $3, 'open')`,
      [TENANT, CLIENT, PAYER],
    );

    const env = await reconSuggestMatches(ctx(), {});

    expect(env.data.suggestions).toHaveLength(0);
    expect(env.data.unmatched_records).toBe(1);
    expect(env.warnings.map((w) => w.code)).toContain('PRICE_MISSING');
  });
});

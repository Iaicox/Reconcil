import { createDb, runMigrations, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ToolContext } from '../src/context.js';
import { reconStatus } from '../src/tools/recon-status.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

const TENANT = '00000000-0000-0000-0000-000000000001';
const TENANT2 = '00000000-0000-0000-0000-000000000002';
const CLIENT = '00000000-0000-0000-0000-0000000000c1';
const CLIENT2 = '00000000-0000-0000-0000-0000000000c2';
const MISSING_CLIENT = '00000000-0000-0000-0000-0000000000cf'; // well-formed but absent

const WALLET = `0x${'1'.repeat(40)}`; // tenant/CLIENT receiving wallet
const WALLET2 = `0x${'3'.repeat(40)}`; // tenant/CLIENT2 receiving wallet
const OUTSIDER = `0x${'9'.repeat(40)}`; // not a tracked wallet
const PAYER = `0x${'2'.repeat(40)}`;

const EUR_TOKEN = `0x${'c'.repeat(40)}`;
const UNVERIFIED_TOKEN = `0x${'e'.repeat(40)}`;
const NONSTABLE_TOKEN = `0x${'f'.repeat(40)}`;

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
    'TRUNCATE tenants, clients, wallets, tokens, chain_events, external_records, matches, tool_calls, ingestion_checkpoints RESTART IDENTITY CASCADE',
  );
  await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'acme', 'acme')`, [TENANT]);
  await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Client One')`, [CLIENT, TENANT]);
  await pool.query(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $2, 'Client Two')`, [CLIENT2, TENANT]);
  await pool.query(`INSERT INTO wallets (tenant_id, client_id, address) VALUES ($1, $2, $3)`, [TENANT, CLIENT, WALLET]);
  await pool.query(`INSERT INTO wallets (tenant_id, client_id, address) VALUES ($1, $2, $3)`, [TENANT, CLIENT2, WALLET2]);
});

const ctx = (tenantId = TENANT): ToolContext => ({ db, tenantId });

interface TokenOpts {
  address?: string; symbol?: string; decimals?: number;
  isStablecoin?: boolean; peg?: string | null; verified?: boolean;
}
/** Seed a token; defaults to a verified EUR-pegged stablecoin (6 decimals). Returns its id. */
async function seedToken(opts: TokenOpts = {}): Promise<number> {
  const { address = EUR_TOKEN, symbol = 'EURC', decimals = 6, isStablecoin = true, peg = 'EUR', verified = true } = opts;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tokens (chain_id, address, standard, symbol_display, decimals, is_stablecoin, peg_currency, verified)
     VALUES (1, $1, 'erc20', $2, $3, $4, $5, $6) RETURNING id`,
    [address, symbol, decimals, isStablecoin, peg, verified],
  );
  return Number(rows[0]!.id);
}

interface EventOpts { logIndex?: number; from?: string; to?: string; blockTime?: string }
/** A stablecoin transfer `from → to` of `amountRaw` base units. Returns the event id. */
async function seedEvent(tokenId: number, amountRaw: string, opts: EventOpts = {}): Promise<number> {
  const { logIndex = 0, from = PAYER, to = WALLET, blockTime = '2026-06-14T10:00:00Z' } = opts;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO chain_events
       (chain_id, tx_hash, log_index, event_kind, token_id, amount_raw, from_addr, to_addr, block_number, block_time, tx_from, provider, raw)
     VALUES (1, $1, $2, 'erc20_transfer', $3, $4, $5, $6, 100, $7, $5, 'test', '{}'::jsonb)
     RETURNING id`,
    [`0x${logIndex.toString().padStart(64, 'a')}`, logIndex, tokenId, amountRaw, from, to, blockTime],
  );
  return Number(rows[0]!.id);
}

interface InvoiceOpts {
  currency?: string; status?: string; issuedOn?: string;
  clientId?: string | null; tenantId?: string;
}
/** A receivable in a given status/currency. Returns its record id. */
async function seedInvoice(externalRef: string, amount: string, opts: InvoiceOpts = {}): Promise<string> {
  const { currency = 'EUR', status = 'open', issuedOn = '2026-06-01', clientId = CLIENT, tenantId = TENANT } = opts;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO external_records
       (tenant_id, client_id, kind, direction, source, external_ref, amount, currency, issued_on, status)
     VALUES ($1, $2, 'invoice', 'receivable', 'csv', $3, $4, $5, $6, $7) RETURNING id`,
    [tenantId, clientId, externalRef, amount, currency, issuedOn, status],
  );
  return rows[0]!.id;
}

/** A confirmed match leg valuing `fiatValue` of `eventId` against `recordId`. Returns its id. */
async function seedConfirmedLeg(
  recordId: string, eventId: number, amountAppliedRaw: string, fiatValue: string,
  opts: { currency?: string; tenantId?: string } = {},
): Promise<string> {
  const { currency = 'EUR', tenantId = TENANT } = opts;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO matches
       (tenant_id, external_record_id, chain_event_id, amount_applied_raw, fiat_value, fiat_currency, status, matched_by, confirmed_by, confirmed_at, confidence, rationale)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', 'agent', 'agent', now(), 0.9, '{}'::jsonb) RETURNING id`,
    [tenantId, recordId, eventId, amountAppliedRaw, fiatValue, currency],
  );
  return rows[0]!.id;
}

describe('recon_status — record counts by status', () => {
  it('counts records per status, defaulting absent statuses to 0', async () => {
    await seedInvoice('INV-O1', '100.00', { status: 'open' });
    await seedInvoice('INV-O2', '100.00', { status: 'open' });
    await seedInvoice('INV-P', '100.00', { status: 'partially_matched' });
    await seedInvoice('INV-M', '100.00', { status: 'matched' });
    await seedInvoice('INV-OV', '100.00', { status: 'overpaid' });
    await seedInvoice('INV-V', '100.00', { status: 'void' });

    const env = await reconStatus(ctx(), {});

    expect(env.data.records).toEqual({
      open: 2, partially_matched: 1, matched: 1, overpaid: 1, void: 1,
    });
  });

  it('returns an all-zero record map for an empty tenant', async () => {
    await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'empty', 'empty')`, [TENANT2]);

    const env = await reconStatus(ctx(TENANT2), {});

    expect(env.data.records).toEqual({
      open: 0, partially_matched: 0, matched: 0, overpaid: 0, void: 0,
    });
    expect(env.data.open_amounts).toEqual([]);
    expect(env.data.overpayments).toEqual([]);
    expect(env.data.unmatched_settlements.count).toBe(0);
    expect(env.data.unmatched_settlements.sample).toEqual([]);
    expect(env.citations.tool_call_id).toBeTruthy();
    expect(env.citations.coverage).toEqual([]);

    // Read tool still persists its tool_call before responding (C2).
    const tc = await pool.query<{ tool_name: string }>(`SELECT tool_name FROM tool_calls`);
    expect(tc.rows[0]!.tool_name).toBe('recon_status');
  });
});

describe('recon_status — open amounts per currency', () => {
  it('sums (amount − confirmed) over open/partial records, grouped by currency', async () => {
    const tokenId = await seedToken();
    await seedInvoice('INV-EUR-OPEN', '1000.00', { status: 'open' }); // open 1000.00
    const partial = await seedInvoice('INV-EUR-PART', '500.00', { status: 'partially_matched' });
    const ev = await seedEvent(tokenId, '200000000', { logIndex: 1 });
    await seedConfirmedLeg(partial, ev, '200000000', '200.00'); // open 300.00
    await seedInvoice('INV-USD-OPEN', '100.00', { currency: 'USD', status: 'open' }); // open 100.00

    // A fully-matched record must not contribute to outstanding open amounts.
    const matched = await seedInvoice('INV-EUR-DONE', '9999.00', { status: 'matched' });
    const ev2 = await seedEvent(tokenId, '9999000000', { logIndex: 2 });
    await seedConfirmedLeg(matched, ev2, '9999000000', '9999.00');

    const env = await reconStatus(ctx(), {});

    expect(env.data.open_amounts).toEqual([
      { currency: 'EUR', value: '1300.00' },
      { currency: 'USD', value: '100.00' },
    ]);
  });
});

describe('recon_status — confirmed-leg currency predicate (C6)', () => {
  it('ignores a wrong-currency confirmed leg when computing open_amounts', async () => {
    const tokenId = await seedToken();
    const rec = await seedInvoice('INV-EUR', '1000.00', { status: 'open' });
    const evEur = await seedEvent(tokenId, '400000000', { logIndex: 1 });
    await seedConfirmedLeg(rec, evEur, '400000000', '400.00'); // real EUR leg → 600.00 open

    // A confirmed leg in the WRONG currency on the SAME record, inserted via raw SQL — the
    // normal writer (match-repo.ts) always pins fiat_currency = record currency, so this
    // bypasses it deliberately to prove the currency predicate, not just exercise it.
    const evUsd = await seedEvent(tokenId, '999999000000', { logIndex: 2 });
    await pool.query(
      `INSERT INTO matches
         (tenant_id, external_record_id, chain_event_id, amount_applied_raw, fiat_value, fiat_currency, status, matched_by, confirmed_by, confirmed_at, confidence, rationale)
       VALUES ($1,$2,$3,$4,$5,'USD','confirmed','agent','agent',now(),0.9,'{}'::jsonb)`,
      [TENANT, rec, evUsd, '999999000000', '999999.00'],
    );

    const env = await reconStatus(ctx(), {});

    expect(env.data.open_amounts).toEqual([{ currency: 'EUR', value: '600.00' }]);
  });
});

describe('recon_status — overpayments', () => {
  it('reports the excess (confirmed − amount) for each overpaid record', async () => {
    const tokenId = await seedToken();
    const over = await seedInvoice('INV-OVER', '1000.00', { status: 'overpaid' });
    const ev = await seedEvent(tokenId, '1500000000', { logIndex: 1 });
    await seedConfirmedLeg(over, ev, '1500000000', '1500.00');
    await seedInvoice('INV-OPEN', '1000.00', { status: 'open' }); // not overpaid → excluded

    const env = await reconStatus(ctx(), {});

    expect(env.data.overpayments).toEqual([
      { record_id: over, external_ref: 'INV-OVER', excess: '500.00', currency: 'EUR' },
    ]);
  });
});

describe('recon_status — unmatched settlements (authoritative view)', () => {
  it('counts settlements with no confirmed leg, excluding matched/spam/foreign events', async () => {
    const eur = await seedToken();
    const unverified = await seedToken({ address: UNVERIFIED_TOKEN, symbol: 'FAKE', verified: false });
    const nonstable = await seedToken({ address: NONSTABLE_TOKEN, symbol: 'WETH', isStablecoin: false, peg: null });

    // INCLUDED: verified stablecoin settlement into the tenant wallet, no confirmed leg.
    const unmatched = await seedEvent(eur, '1000000000', { logIndex: 1 });

    // INCLUDED: verified NON-stablecoin settlement, no confirmed leg. The matcher now values &
    // matches volatile tokens, so the authoritative view shares its widened gate (no drift).
    await seedEvent(nonstable, '5000000000', { logIndex: 4 });

    // EXCLUDED: has a confirmed leg.
    const applied = await seedEvent(eur, '2000000000', { logIndex: 2 });
    const rec = await seedInvoice('INV-APPLIED', '2000.00', { status: 'matched' });
    await seedConfirmedLeg(rec, applied, '2000000000', '2000.00');

    // EXCLUDED: unverified (spam) token, zero-value spam, foreign wallet.
    await seedEvent(unverified, '5000000000', { logIndex: 3 });
    await seedEvent(eur, '0', { logIndex: 5 });
    await seedEvent(eur, '5000000000', { logIndex: 6, from: PAYER, to: OUTSIDER });

    const env = await reconStatus(ctx(), {});

    expect(env.data.unmatched_settlements.count).toBe(2);
    expect(env.data.unmatched_settlements.sample).toHaveLength(2);
    expect(env.data.unmatched_settlements.sample.map((s) => s.log_index).sort((a, b) => a - b)).toEqual([1, 4]);
    expect(env.data.unmatched_settlements.drilldown.tool).toBe('analytics_list_events');

    // Sanity: the verified-stablecoin unmatched event is among the counted settlements.
    const { rows } = await pool.query<{ tx_hash: string }>(`SELECT tx_hash FROM chain_events WHERE id = $1`, [unmatched]);
    expect(env.data.unmatched_settlements.sample.map((s) => s.tx_hash)).toContain(rows[0]!.tx_hash);
  });

  it('excludes internal wallet↔wallet transfers, includes outbound payable settlements', async () => {
    const eur = await seedToken();
    // internal: both endpoints are the tenant's own wallets → not a settlement of any record.
    await seedEvent(eur, '1000000000', { logIndex: 1, from: WALLET, to: WALLET2 });
    // outbound: from a tracked wallet to an outsider → a payable-shaped settlement, still counted.
    const outbound = await seedEvent(eur, '2000000000', { logIndex: 2, from: WALLET, to: OUTSIDER });

    const env = await reconStatus(ctx(), {});

    expect(env.data.unmatched_settlements.count).toBe(1);
    expect(env.data.unmatched_settlements.sample).toHaveLength(1);
    const { rows } = await pool.query<{ tx_hash: string }>(`SELECT tx_hash FROM chain_events WHERE id = $1`, [outbound]);
    expect(env.data.unmatched_settlements.sample[0]!.tx_hash).toBe(rows[0]!.tx_hash);
  });
});

describe('recon_status — coverage / staleness (C5)', () => {
  it('surfaces a coverage warning when a wallet in scope is still backfilling', async () => {
    const eur = await seedToken();
    await seedEvent(eur, '1000000000', { logIndex: 1 }); // a settlement to read from chain_events
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status) VALUES (1, $1, 'erc20', 'backfilling')`,
      [WALLET],
    );

    const env = await reconStatus(ctx(), {});

    expect(env.citations.coverage.length).toBeGreaterThan(0);
    expect(env.warnings).toContainEqual(expect.objectContaining({ code: 'COVERAGE_INCOMPLETE' }));
  });
});

describe('recon_status — client and period scoping', () => {
  it('scopes records, open amounts and settlements to a client', async () => {
    const tokenId = await seedToken();
    await seedInvoice('INV-C1', '1000.00', { clientId: CLIENT, status: 'open' });
    await seedInvoice('INV-C2', '500.00', { clientId: CLIENT2, status: 'open' });
    await seedEvent(tokenId, '1000000000', { logIndex: 1, to: WALLET }); // CLIENT wallet
    await seedEvent(tokenId, '2000000000', { logIndex: 2, to: WALLET2 }); // CLIENT2 wallet

    const env = await reconStatus(ctx(), { client_id: CLIENT });

    expect(env.data.records.open).toBe(1);
    expect(env.data.open_amounts).toEqual([{ currency: 'EUR', value: '1000.00' }]);
    expect(env.data.unmatched_settlements.count).toBe(1);
    expect(env.data.unmatched_settlements.sample[0]).toMatchObject({ log_index: 1 });
    // The self-citing drilldown must re-enumerate the SAME wallet subset (C3), not the tenant.
    expect(env.data.unmatched_settlements.drilldown.args).toEqual({ scope: { client_id: CLIENT } });
  });

  it('rejects an unknown client_id with INVALID_INPUT', async () => {
    await expect(reconStatus(ctx(), { client_id: MISSING_CLIENT })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('filters records by issued_on and settlements by block_time within the period', async () => {
    const tokenId = await seedToken();
    await seedInvoice('INV-JUN', '1000.00', { status: 'open', issuedOn: '2026-06-10' });
    await seedInvoice('INV-AUG', '1000.00', { status: 'open', issuedOn: '2026-08-10' });
    await seedEvent(tokenId, '1000000000', { logIndex: 1, blockTime: '2026-06-14T10:00:00Z' });
    // Intraday event on the 'to' day must land inside the (inclusive) period window.
    await seedEvent(tokenId, '1000000000', { logIndex: 3, blockTime: '2026-06-30T23:30:00Z' });
    await seedEvent(tokenId, '1000000000', { logIndex: 2, blockTime: '2026-08-14T10:00:00Z' });

    const env = await reconStatus(ctx(), { period: { from: '2026-06-01', to: '2026-06-30' } });

    expect(env.data.records.open).toBe(1);
    expect(env.data.open_amounts).toEqual([{ currency: 'EUR', value: '1000.00' }]);
    expect(env.data.unmatched_settlements.count).toBe(2); // both June events, incl. the to-day one
    expect(env.data.unmatched_settlements.sample.map((s) => s.log_index).sort()).toEqual([1, 3]);
  });
});

/**
 * Drizzle schema. Source DDL: docs/architecture/schema.sql — the schema here
 * must stay in sync with it (ADR-002); migrations are generated as plain SQL
 * into ./migrations and are hand-auditable.
 *
 * Parity rules (docs/superpowers/specs/2026-07-14-drizzle-schema-migration-design.md):
 *   - section order and constraint/index names mirror schema.sql 1:1; unnamed
 *     inline constraints carry the names Postgres would auto-generate;
 *   - CHECK expressions are copied verbatim from schema.sql;
 *   - NUMERIC(78,0) money columns are mode 'bigint' (ADR-004); identity ids
 *     and block numbers are mode 'number' (far below 2^53, not money).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Buffer } from 'node:buffer';

/** BYTEA — drizzle-orm has no built-in bytea column type (as of 0.45.2). */
const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

// ---------------------------------------------------------------- tenancy ---

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique('tenants_slug_key'),
  name: text('name').notNull(),
  // valuation_policy ('market'|'peg_for_stables'), base_currency, locale...
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// An accounting firm's sub-clients ($199 multi-client tier). Optional in
// single-company mode (wallets.client_id stays NULL).
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    baseCurrency: text('base_currency').notNull().default('USD'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'clients_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    unique('clients_tenant_id_name_key').on(t.tenantId, t.name),
  ],
);

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id'),
    address: text('address').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'wallets_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'wallets_client_id_fkey',
      columns: [t.clientId],
      foreignColumns: [clients.id],
    }).onDelete('set null'),
    check('wallets_address_check', sql`address = lower(address)`),
    unique('wallets_tenant_id_address_key').on(t.tenantId, t.address),
    // Reverse lookup: which tenants track this address (ingestion fan-out,
    // event scoping).
    index('wallets_address_idx').on(t.address),
  ],
);

// Bearer keys for the hosted streamable-HTTP transport (ADR-012).
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    // sha256(key); plaintext never stored
    keyHash: text('key_hash').notNull().unique('api_keys_key_hash_key'),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'api_keys_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
  ],
);

// ------------------------------------------------------------ chain data ---

// Global token registry. The native currency of each chain is a pseudo-token
// row (address IS NULL) so every event references a token uniformly.
export const tokens = pgTable(
  'tokens',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    chainId: integer('chain_id').notNull(),
    address: text('address'),
    standard: text('standard').$type<'native' | 'erc20'>().notNull(),
    symbolRaw: text('symbol_raw'), // as fetched on-chain: HOSTILE, never shown to LLM
    nameRaw: text('name_raw'), // HOSTILE
    symbolDisplay: text('symbol_display'), // sanitized (core/sanitizer), safe for LLM context
    nameDisplay: text('name_display'), // sanitized
    decimals: integer('decimals').notNull(),
    isStablecoin: boolean('is_stablecoin').notNull().default(false),
    pegCurrency: text('peg_currency'), // 'USD' | 'EUR' when is_stablecoin
    verified: boolean('verified').notNull().default(false), // curated allowlist vs auto-discovered (spam)
    coingeckoId: text('coingecko_id'), // price-source mapping; DefiLlama keys by (chain, address)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tokens_address_check', sql`address IS NULL OR address = lower(address)`),
    check('tokens_standard_check', sql`standard IN ('native', 'erc20')`),
    check('tokens_decimals_check', sql`decimals BETWEEN 0 AND 36`),
    check('tokens_native_iff_no_addr', sql`(standard = 'native') = (address IS NULL)`),
    unique('tokens_chain_id_address_key').on(t.chainId, t.address).nullsNotDistinct(),
  ],
);

// Append-only event store (P3). GLOBAL: public chain data, shared across
// tenants. Rows are never updated or deleted; reorg safety is by construction
// (ingestion never passes head - finality_depth, see 03-ingestion.md).
export const chainEvents = pgTable(
  'chain_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    chainId: integer('chain_id').notNull(),
    // lowercase 0x-hex(64); synthetic 'anchor:<addr>:<block>' for opening_balance
    txHash: text('tx_hash').notNull(),
    // sentinels: -1 native transfer, -2 gas fee, -3 opening balance;
    // reserved: -(1000+n) for future internal (trace) transfers
    logIndex: integer('log_index').notNull(),
    eventKind: text('event_kind')
      .$type<'native_transfer' | 'erc20_transfer' | 'gas_fee' | 'opening_balance'>()
      .notNull(),
    tokenId: bigint('token_id', { mode: 'number' }).notNull(),
    amountRaw: numeric('amount_raw', { precision: 78, scale: 0, mode: 'bigint' }).notNull(),
    fromAddr: text('from_addr').notNull(),
    toAddr: text('to_addr').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    txFrom: text('tx_from').notNull(), // tx-level sender (gas payer, counterparty resolution)
    txTo: text('tx_to'), // NULL for contract creation
    provider: text('provider').notNull(), // which provider supplied this row (audit)
    // provider payload as received; server-side only, never sent to LLM
    raw: jsonb('raw').$type<unknown>().notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'chain_events_token_id_fkey',
      columns: [t.tokenId],
      foreignColumns: [tokens.id],
    }),
    check(
      'chain_events_event_kind_check',
      sql`event_kind IN ('native_transfer', 'erc20_transfer', 'gas_fee', 'opening_balance')`,
    ),
    check('chain_events_amount_raw_check', sql`amount_raw >= 0`),
    check('chain_events_from_addr_check', sql`from_addr = lower(from_addr)`),
    check('chain_events_to_addr_check', sql`to_addr = lower(to_addr)`),
    // Idempotency key (P3/P4): safe re-ingestion via ON CONFLICT DO NOTHING.
    // token_id is functionally dependent on (chain_id, tx_hash, log_index) for real
    // logs; it is load-bearing for anchored opening balances, which write one event
    // per token under a single synthetic tx_hash / log_index slot (03-ingestion.md).
    unique('chain_events_idempotency').on(t.chainId, t.txHash, t.logIndex, t.tokenId),
    // Flow queries: "events where X is sender/recipient in period".
    // chain_id is filtered after the address probe: address selectivity dominates.
    index('chain_events_from_idx').on(t.fromAddr, t.blockTime),
    index('chain_events_to_idx').on(t.toAddr, t.blockTime),
    // Integrity checks and coverage math per chain height.
    index('chain_events_block_idx').on(t.chainId, t.blockNumber),
    // Token-level scans (stablecoin movement queries, spam audits).
    index('chain_events_token_idx').on(t.tokenId),
  ],
);

// ---------------------------------------------------------------- pricing ---

// Daily UTC close snapshots (P5). Append-only: corrections are new rows under
// a different source ('manual'); calculations pin the exact row they used by FK.
export const priceSnapshots = pgTable(
  'price_snapshots',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tokenId: bigint('token_id', { mode: 'number' }).notNull(),
    priceDate: date('price_date').notNull(), // UTC day
    currency: text('currency').notNull().default('USD'),
    price: numeric('price').notNull(), // per 1 whole token (display units)
    source: text('source').notNull(), // 'defillama' | 'coingecko' | 'peg' | 'manual'
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'price_snapshots_token_id_fkey',
      columns: [t.tokenId],
      foreignColumns: [tokens.id],
    }),
    check('price_snapshots_price_check', sql`price >= 0`),
    unique('price_snapshots_token_id_price_date_currency_source_key').on(
      t.tokenId,
      t.priceDate,
      t.currency,
      t.source,
    ),
  ],
);

// ECB daily reference rates (P5). Weekend/holiday rule: use latest prior row.
export const fxRates = pgTable(
  'fx_rates',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    rateDate: date('rate_date').notNull(),
    baseCurrency: text('base_currency').notNull(), // 'EUR' (ECB publishes EUR-based)
    quoteCurrency: text('quote_currency').notNull(), // 'USD', ...
    rate: numeric('rate').notNull(),
    source: text('source').notNull().default('ecb'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('fx_rates_rate_check', sql`rate > 0`),
    unique('fx_rates_rate_date_base_currency_quote_currency_source_key').on(
      t.rateDate,
      t.baseCurrency,
      t.quoteCurrency,
      t.source,
    ),
  ],
);

// -------------------------------------------------------------- directory ---

// Address book. tenant_id NULL = built-in curated labels (exchanges, routers),
// shipped as seed data, read-only for tenants.
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id'),
    clientId: uuid('client_id'),
    name: text('name').notNull(),
    kind: text('kind')
      .$type<'self' | 'client' | 'vendor' | 'exchange' | 'contract' | 'employee' | 'other'>()
      .notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'entities_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'entities_client_id_fkey',
      columns: [t.clientId],
      foreignColumns: [clients.id],
    }).onDelete('set null'),
    check(
      'entities_kind_check',
      sql`kind IN ('self', 'client', 'vendor', 'exchange', 'contract', 'employee', 'other')`,
    ),
    index('entities_tenant_idx').on(t.tenantId),
  ],
);

export const entityAddresses = pgTable(
  'entity_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityId: uuid('entity_id').notNull(),
    // Denormalized from entities to make the uniqueness rule enforceable in-DB:
    // one owner per (tenant, chain, address). Kept in sync by the repository layer.
    tenantId: uuid('tenant_id'),
    chainId: integer('chain_id'), // NULL = applies to any EVM chain
    address: text('address').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'entity_addresses_entity_id_fkey',
      columns: [t.entityId],
      foreignColumns: [entities.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'entity_addresses_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    check('entity_addresses_address_check', sql`address = lower(address)`),
    unique('entity_addresses_tenant_id_chain_id_address_key')
      .on(t.tenantId, t.chainId, t.address)
      .nullsNotDistinct(),
    index('entity_addresses_addr_idx').on(t.address),
  ],
);

// ---------------------------------------------------------- reconciliation ---

// Source-agnostic external records (Option C seam #1): an invoice is just one
// `kind`. Future kinds ('bill', 'agent_charge', ...) reuse the matching engine.
export const externalRecords = pgTable(
  'external_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id'),
    kind: text('kind').notNull().default('invoice'),
    direction: text('direction').$type<'receivable' | 'payable'>().notNull(),
    source: text('source').notNull(), // 'csv' | 'manual' | 'api'
    externalRef: text('external_ref').notNull(), // invoice number etc.
    counterpartyEntityId: uuid('counterparty_entity_id'),
    counterpartyName: text('counterparty_name'), // raw from import: HOSTILE
    amount: numeric('amount').notNull(), // gross, in `currency`
    currency: text('currency').notNull(), // 'EUR' | 'USD' | ...
    vatRate: numeric('vat_rate'), // percent, e.g. 21.0
    vatAmount: numeric('vat_amount'),
    issuedOn: date('issued_on'),
    dueOn: date('due_on'),
    expectedTokenId: bigint('expected_token_id', { mode: 'number' }),
    expectedAddress: text('expected_address'),
    status: text('status')
      .$type<'open' | 'partially_matched' | 'matched' | 'overpaid' | 'void'>()
      .notNull()
      .default('open'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}), // raw import row (audit)
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'external_records_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'external_records_client_id_fkey',
      columns: [t.clientId],
      foreignColumns: [clients.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'external_records_counterparty_entity_id_fkey',
      columns: [t.counterpartyEntityId],
      foreignColumns: [entities.id],
    }),
    foreignKey({
      name: 'external_records_expected_token_id_fkey',
      columns: [t.expectedTokenId],
      foreignColumns: [tokens.id],
    }),
    check('external_records_direction_check', sql`direction IN ('receivable', 'payable')`),
    check('external_records_amount_check', sql`amount >= 0`),
    check(
      'external_records_expected_address_check',
      sql`expected_address IS NULL OR expected_address = lower(expected_address)`,
    ),
    check(
      'external_records_status_check',
      sql`status IN ('open', 'partially_matched', 'matched', 'overpaid', 'void')`,
    ),
    // Idempotent re-import of the same CSV, partitioned per client (ADR-006): two
    // clients of one firm may legitimately use the same invoice number. NULLS NOT
    // DISTINCT so single-company rows (client_id IS NULL) still dedupe.
    // Caveat: dedupe holds only while client_id resolution is deterministic across
    // imports. Re-importing a file after rows were re-attributed (client_id NULL →
    // client X) inserts duplicates instead of skipping — the import path must
    // resolve client_id identically on every run, or match on the
    // pre-attribution key before insert.
    unique('external_records_import_idempotency')
      .on(t.tenantId, t.clientId, t.kind, t.source, t.externalRef)
      .nullsNotDistinct(),
    index('external_records_status_idx').on(t.tenantId, t.status),
    index('external_records_period_idx').on(t.tenantId, t.issuedOn),
  ],
);

// Pair-level match legs: m:n between external records and settlement events
// (partial payments, overpayments, split settlements, fee shortfalls).
// Cross-row invariants (sum of applied <= event amount; record status
// derivation) are enforced in the repository layer under SERIALIZABLE tx +
// property tests (triggers rejected: logic duplication, see ADR-010).
export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    externalRecordId: uuid('external_record_id').notNull(),
    chainEventId: bigint('chain_event_id', { mode: 'number' }).notNull(),
    // Portion of the event applied to this record, token base units.
    amountAppliedRaw: numeric('amount_applied_raw', {
      precision: 78,
      scale: 0,
      mode: 'bigint',
    }).notNull(),
    // Valuation of that portion, pinned to the exact price/FX rows used (P5).
    fiatValue: numeric('fiat_value').notNull(),
    fiatCurrency: text('fiat_currency').notNull(),
    priceSnapshotId: bigint('price_snapshot_id', { mode: 'number' }),
    fxRateId: bigint('fx_rate_id', { mode: 'number' }),
    status: text('status')
      .$type<'suggested' | 'confirmed' | 'rejected'>()
      .notNull()
      .default('suggested'),
    matchedBy: text('matched_by').$type<'auto' | 'agent' | 'manual'>().notNull(),
    confidence: numeric('confidence'),
    rationale: jsonb('rationale').$type<Record<string, unknown>>().notNull().default({}), // rule hits explaining the suggestion
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by'),
  },
  (t) => [
    foreignKey({
      name: 'matches_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'matches_external_record_id_fkey',
      columns: [t.externalRecordId],
      foreignColumns: [externalRecords.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'matches_chain_event_id_fkey',
      columns: [t.chainEventId],
      foreignColumns: [chainEvents.id],
    }),
    foreignKey({
      name: 'matches_price_snapshot_id_fkey',
      columns: [t.priceSnapshotId],
      foreignColumns: [priceSnapshots.id],
    }),
    foreignKey({
      name: 'matches_fx_rate_id_fkey',
      columns: [t.fxRateId],
      foreignColumns: [fxRates.id],
    }),
    check('matches_amount_applied_raw_check', sql`amount_applied_raw > 0`),
    check('matches_status_check', sql`status IN ('suggested', 'confirmed', 'rejected')`),
    check('matches_matched_by_check', sql`matched_by IN ('auto', 'agent', 'manual')`),
    check('matches_confidence_check', sql`confidence BETWEEN 0 AND 1`),
    index('matches_record_idx').on(t.externalRecordId),
    index('matches_event_idx').on(t.chainEventId),
    index('matches_status_idx').on(t.tenantId, t.status),
  ],
);

// --------------------------------------------------------------- ingestion ---

// Cursor per (chain, address, stream). GLOBAL: two tenants tracking the same
// address share one checkpoint and one backfill. 'native' and 'erc20' are
// separate provider endpoints, hence separate cursors.
export const ingestionCheckpoints = pgTable(
  'ingestion_checkpoints',
  {
    chainId: integer('chain_id').notNull(),
    address: text('address').notNull(),
    stream: text('stream').$type<'native' | 'erc20'>().notNull(),
    status: text('status')
      .$type<'queued' | 'anchoring' | 'backfilling' | 'live' | 'paused' | 'error'>()
      .notNull()
      .default('queued'),
    // Events are complete for blocks <= last_processed_block (within coverage).
    lastProcessedBlock: bigint('last_processed_block', { mode: 'number' }).notNull().default(0),
    // Non-NULL => anchored-window backfill: coverage starts here, opening_balance
    // event anchors the baseline (ADR-008).
    anchorBlock: bigint('anchor_block', { mode: 'number' }),
    backfillStartedAt: timestamp('backfill_started_at', { withTimezone: true }),
    backfillCompletedAt: timestamp('backfill_completed_at', { withTimezone: true }),
    // Last balance-vs-provider drift check result: {checked_at, block, drifts:[...]}.
    lastIntegrity: jsonb('last_integrity').$type<unknown>(),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Appended by migration 0001 (ALTER ADD COLUMN → physical end; parity keeps
    // schema.sql / schema.ts in the same order). Requested anchor date for
    // mode='anchored' (ledger_track_wallet writes it; the worker resolves it to
    // anchor_block via getBlockByTime during 'anchoring').
    anchorFrom: date('anchor_from'),
    // >50k probe (ADR-008, tunable Q5): provider-estimated tx count, stored on the
    // native stream row; drives ledger_status.suggests_anchored. NULL until probed.
    txCountHint: bigint('tx_count_hint', { mode: 'number' }),
  },
  (t) => [
    primaryKey({
      name: 'ingestion_checkpoints_pkey',
      columns: [t.chainId, t.address, t.stream],
    }),
    check('ingestion_checkpoints_address_check', sql`address = lower(address)`),
    check('ingestion_checkpoints_stream_check', sql`stream IN ('native', 'erc20')`),
    check(
      'ingestion_checkpoints_status_check',
      sql`status IN ('queued', 'anchoring', 'backfilling', 'live', 'paused', 'error')`,
    ),
  ],
);

// --------------------------------------------------------------- interface ---

// Persisted tool invocations: the anchor for citations (P2). Every MCP tool
// response carries a tool_call_id referencing a row here; trace_tool_call
// replays it. Also the audit/usage log.
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: text('id').primaryKey(), // ULID (lexically time-ordered)
    tenantId: uuid('tenant_id').notNull(),
    toolName: text('tool_name').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    resultDigest: text('result_digest').notNull(), // sha256 of canonical result JSON
    // coverage snapshot at call time (replayable)
    coverage: jsonb('coverage').$type<unknown[]>().notNull().default([]),
    calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'tool_calls_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    index('tool_calls_tenant_time_idx').on(t.tenantId, t.calledAt),
  ],
);

// QuickBooks/Xero OAuth tokens, AES-256-GCM under MASTER_KEY (P9). Plaintext
// exists only in memory during an export run; key_version enables rotation.
export const integrationCredentials = pgTable(
  'integration_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    provider: text('provider').$type<'quickbooks' | 'xero'>().notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'integration_credentials_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    check('integration_credentials_provider_check', sql`provider IN ('quickbooks', 'xero')`),
    unique('integration_credentials_tenant_id_provider_key').on(t.tenantId, t.provider),
  ],
);

// Export artifact registry + audit manifest (which coverage, price snapshots
// and tool calls produced each file). Bound as `exportsTable` to avoid
// clashing with the module keyword; wire name stays 'exports'.
export const exportsTable = pgTable(
  'exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    clientId: uuid('client_id'),
    kind: text('kind')
      .$type<'close_pack' | 'pdf_summary' | 'journal_qbo' | 'journal_xero'>()
      .notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status')
      .$type<'pending' | 'running' | 'done' | 'failed'>()
      .notNull()
      .default('pending'),
    filePath: text('file_path'),
    manifest: jsonb('manifest').$type<unknown>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'exports_tenant_id_fkey',
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'exports_client_id_fkey',
      columns: [t.clientId],
      foreignColumns: [clients.id],
    }).onDelete('set null'),
    check(
      'exports_kind_check',
      sql`kind IN ('close_pack', 'pdf_summary', 'journal_qbo', 'journal_xero')`,
    ),
    check('exports_status_check', sql`status IN ('pending', 'running', 'done', 'failed')`),
    index('exports_tenant_idx').on(t.tenantId, t.createdAt),
  ],
);

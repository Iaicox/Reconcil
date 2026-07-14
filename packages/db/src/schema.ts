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
    unique('chain_events_idempotency').on(t.chainId, t.txHash, t.logIndex),
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

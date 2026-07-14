# Drizzle Schema + Initial Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Executable Drizzle schema in `@pet-crypto/db` mirroring `docs/architecture/schema.sql` (15 tables), with a generated SQL migration `0000` proven byte-identical (via `pg_dump` diff) to the reference DDL on Postgres 16.

**Architecture:** TS-schema-first (approved spec: `docs/superpowers/specs/2026-07-14-drizzle-schema-migration-design.md`). `src/schema.ts` is hand-written in the same section order as `schema.sql`; `drizzle-kit generate` produces the migration; parity is verified by applying migration and reference DDL to two fresh databases in one disposable postgres:16 container and diffing schema-only dumps.

**Tech Stack:** drizzle-orm 0.45.2 + drizzle-kit 0.31.10 (already in `packages/db/package.json` — verified installed), pg / node-postgres, TypeScript strict with project references, Docker (postgres:16) for verification.

## Global Constraints

- **Money is never `number`** (ADR-004): `NUMERIC(78,0)` columns use `numeric({ precision: 78, scale: 0, mode: 'bigint' })`; fiat `NUMERIC` columns stay in default string mode. Identity ids and block numbers use `bigint(..., { mode: 'number' })` — they stay far below 2^53 and are not money.
- **Do not modify** `docs/architecture/schema.sql` — it is the annotated reference. Any parity fix goes into `src/schema.ts`.
- **Never hand-edit generated migration SQL.** Fix `src/schema.ts`, delete `packages/db/migrations/` contents, regenerate (nothing is deployed yet — regenerating `0000` is safe until the gate).
- **Name parity rule:** every constraint/index name in the generated DDL must equal what `schema.sql` produces on Postgres — named constraints verbatim (`chain_events_idempotency`, all `*_idx`), unnamed ones get Postgres auto-names (`<table>_<column>_check`, `<table>_<cols>_key`, `<table>_<column>_fkey`, `<table>_pkey`).
- **CHECK expressions are copied verbatim** from `schema.sql` into `` check(name, sql`…`) ``.
- No new dependencies. No Python. Repo language is English. License Apache-2.0.
- All commits end with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016HbUzUGj8AoYa5qWgequyv
  ```
- Node >= 22.12, pnpm 11. Run package scripts via `pnpm --filter @pet-crypto/db <script>` from the repo root.
- No unit tests for schema shape (spec decision): the verification cycle per task is `tsc -b` build; the end-to-end test is the live-Postgres parity diff (Task 7). `vitest` stays `--passWithNoTests`.

---

### Task 1: Schema foundation + tenancy tables

**Files:**
- Modify: `packages/db/src/schema.ts` (replace the stub entirely)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `tenants`, `clients`, `wallets`, `apiKeys` pgTable exports; `bytea` customType (module-private, used again in Task 5). Later tasks append to this file and reference `tenants.id`, `clients.id`.

- [ ] **Step 1: Replace the stub with the file header, imports, bytea helper, and the tenancy section**

Write `packages/db/src/schema.ts` with exactly this content:

```ts
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
```

Note: `bytea` is intentionally unused until Task 5 — if the linter flags the unused binding, leave it (Task 5 consumes it) and suppress nothing; `tsc` does not error on unused module-level consts (`noUnusedLocals` applies, so if the build fails on `bytea` being unused, move the `bytea` declaration to Task 5 instead and drop it here — the file compiles either way).

- [ ] **Step 2: Build**

Run: `pnpm --filter @pet-crypto/db build`
Expected: exit 0 (compiles `@pet-crypto/core` then `db` via project references). If it fails on `'bytea' is declared but its value is never read`, apply the note from Step 1 (defer the `bytea` helper to Task 5) and rebuild.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(db): tenancy tables in Drizzle schema (tenants, clients, wallets, api_keys)"
```

---

### Task 2: Chain data tables

**Files:**
- Modify: `packages/db/src/schema.ts` (append section)

**Interfaces:**
- Consumes: nothing from Task 1 (tables are FK-independent from tenancy).
- Produces: `tokens`, `chainEvents` exports. Later tasks FK-reference `tokens.id` (Tasks 3, 4) and `chainEvents.id` (Task 4).

- [ ] **Step 1: Append the chain-data section to `packages/db/src/schema.ts`**

```ts
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
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @pet-crypto/db build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(db): chain data tables (tokens, chain_events) with bigint-mode NUMERIC(78,0)"
```

---

### Task 3: Pricing + directory tables

**Files:**
- Modify: `packages/db/src/schema.ts` (append sections)

**Interfaces:**
- Consumes: `tokens.id` (Task 2), `tenants.id`, `clients.id` (Task 1).
- Produces: `priceSnapshots`, `fxRates`, `entities`, `entityAddresses` exports. Task 4 FK-references `priceSnapshots.id`, `fxRates.id`, `entities.id`.

- [ ] **Step 1: Append the pricing and directory sections**

```ts
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
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @pet-crypto/db build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(db): pricing snapshots, fx rates, entity directory tables"
```

---

### Task 4: Reconciliation + ingestion tables

**Files:**
- Modify: `packages/db/src/schema.ts` (append sections)

**Interfaces:**
- Consumes: `tenants.id`, `clients.id` (Task 1); `tokens.id`, `chainEvents.id` (Task 2); `entities.id`, `priceSnapshots.id`, `fxRates.id` (Task 3).
- Produces: `externalRecords`, `matches`, `ingestionCheckpoints` exports.

- [ ] **Step 1: Append the reconciliation and ingestion sections**

```ts
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
    // Idempotent re-import of the same CSV.
    unique('external_records_tenant_id_kind_source_external_ref_key').on(
      t.tenantId,
      t.kind,
      t.source,
      t.externalRef,
    ),
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
      .$type<'queued' | 'backfilling' | 'live' | 'paused' | 'error'>()
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
      sql`status IN ('queued', 'backfilling', 'live', 'paused', 'error')`,
    ),
  ],
);
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @pet-crypto/db build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(db): reconciliation (external_records, matches) and ingestion checkpoint tables"
```

---

### Task 5: Interface tables, db client, drizzle-kit scripts

**Files:**
- Modify: `packages/db/src/schema.ts` (append final section)
- Create: `packages/db/src/client.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/package.json` (scripts only)

**Interfaces:**
- Consumes: `tenants.id`, `clients.id` (Task 1); `bytea` helper (Task 1).
- Produces: `toolCalls`, `integrationCredentials`, `exportsTable` exports; `createDb(pool: Pool): Db` and `type Db` from `client.ts`; package scripts `db:generate`, `db:migrate`, `db:check` used by Tasks 6–7.

- [ ] **Step 1: Append the interface section to `packages/db/src/schema.ts`**

```ts
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
```

If the `bytea` helper was deferred out of Task 1 (see its Step 1 note), add it now directly above `integrationCredentials`, together with the `customType` import and the `import type { Buffer } from 'node:buffer';` line.

- [ ] **Step 2: Create `packages/db/src/client.ts`**

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/** Drizzle handle over an externally owned pg Pool (caller manages lifecycle). */
export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
```

- [ ] **Step 3: Update `packages/db/src/index.ts`**

Replace its content with:

```ts
/**
 * Tenant-scoped repositories over the Drizzle schema. Tenant identity comes
 * from the transport session, never from tool arguments (ADR-006).
 */
export * from './schema.js';
export { createDb, type Db } from './client.js';
```

- [ ] **Step 4: Add drizzle-kit scripts to `packages/db/package.json`**

In the `"scripts"` block, after `"test"`, add:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:check": "drizzle-kit check"
```

- [ ] **Step 5: Build and lint**

Run: `pnpm --filter @pet-crypto/db build && pnpm --filter @pet-crypto/db lint`
Expected: both exit 0. Fix any lint findings (formatting only — no logic changes) before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/client.ts packages/db/src/index.ts packages/db/package.json
git commit -m "feat(db): interface tables (tool_calls, integration_credentials, exports), db client, drizzle-kit scripts"
```

---

### Task 6: Generate migration 0000 and hand-review it

**Files:**
- Create (generated): `packages/db/migrations/0000_*.sql`, `packages/db/migrations/meta/_journal.json`, `packages/db/migrations/meta/0000_snapshot.json`

**Interfaces:**
- Consumes: complete `src/schema.ts` (Tasks 1–5), `db:generate` script (Task 5). `drizzle.config.ts` already points schema → `./src/schema.ts`, out → `./migrations`; do not modify it.
- Produces: the migration file Task 7 applies. `drizzle-kit generate` is offline — no database needed.

- [ ] **Step 1: Generate**

Run: `pnpm --filter @pet-crypto/db db:generate`
Expected: output ends with `Your SQL migration file ➜ migrations/0000_<random-name>.sql 🚀` and reports 15 tables. No errors.

- [ ] **Step 2: Hand-review the generated SQL against `docs/architecture/schema.sql`** (ADR-002: the migration is an audit artifact)

Verify, reading both files side by side:
1. 15 `CREATE TABLE` statements; table and column names all snake_case, matching the reference.
2. Money columns are `numeric(78, 0)`: `chain_events.amount_raw`, `matches.amount_applied_raw`. Fiat numerics (`price`, `rate`, `amount`, `vat_rate`, `vat_amount`, `fiat_value`, `confidence`) are bare `numeric`.
3. All 23 FOREIGN KEY constraints present with `_fkey` names and correct `ON DELETE` actions (cascade for tenant links; set null for client links; none for token/event/snapshot/fx references).
4. `UNIQUE NULLS NOT DISTINCT` on `tokens_chain_id_address_key` and `entity_addresses_tenant_id_chain_id_address_key`.
5. All CHECK constraints present with their expressions verbatim, including `tokens_native_iff_no_addr`.
6. `GENERATED ALWAYS AS IDENTITY` on `tokens.id`, `chain_events.id`, `price_snapshots.id`, `fx_rates.id`.
7. Composite `ingestion_checkpoints_pkey` on (chain_id, address, stream).
8. All 12 secondary indexes with the exact `_idx` names from the reference.
9. `bytea` type on `integration_credentials.ciphertext` / `nonce`; `DEFAULT` clauses match (`'{}'::jsonb`, `'[]'::jsonb`, `'USD'`, `'ecb'`, `'invoice'`, `'open'`, `'queued'`, `'pending'`, `'suggested'`, `0`, `1`, `false`, `now()`, `gen_random_uuid()`).

If anything is off: fix `src/schema.ts`, delete everything under `packages/db/migrations/`, rebuild, regenerate. Never edit the generated SQL.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations
git commit -m "feat(db): generated initial migration 0000 from Drizzle schema"
```

---

### Task 7: Live-Postgres parity verification + full pipeline

**Files:**
- Possibly modify: `packages/db/src/schema.ts` + regenerate `packages/db/migrations/` (only if the diff finds deltas)

**Interfaces:**
- Consumes: `packages/db/migrations/0000_*.sql` (Task 6), `docs/architecture/schema.sql` (read-only reference).
- Produces: verified parity — the spec's acceptance criterion. Requires Docker Desktop running.

- [ ] **Step 1: Spin up disposable Postgres 16 with two databases** (Bash tool; `$SCRATCH` = the session scratchpad directory)

```bash
docker run --rm -d --name schema_parity -e POSTGRES_PASSWORD=x postgres:16
docker exec schema_parity pg_isready -U postgres   # repeat until "accepting connections"
docker exec schema_parity psql -U postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE from_migration' -c 'CREATE DATABASE from_reference'
```

- [ ] **Step 2: Apply the generated migration to one DB and the reference DDL to the other**

`--> statement-breakpoint` lines in the generated file are SQL comments — psql ignores them; applying via psql (not `db:migrate`) keeps the drizzle bookkeeping schema out of the dump.

```bash
docker cp packages/db/migrations/0000_*.sql schema_parity:/m0000.sql
docker cp docs/architecture/schema.sql schema_parity:/reference.sql
docker exec schema_parity psql -U postgres -d from_migration -v ON_ERROR_STOP=1 -q -f /m0000.sql
docker exec schema_parity psql -U postgres -d from_reference -v ON_ERROR_STOP=1 -q -f /reference.sql
```

Expected: both apply with exit 0 and no error output.

- [ ] **Step 3: Dump both schemas and diff**

```bash
docker exec schema_parity pg_dump -U postgres -d from_migration --schema-only --no-owner > "$SCRATCH/dump_migration.sql"
docker exec schema_parity pg_dump -U postgres -d from_reference --schema-only --no-owner > "$SCRATCH/dump_reference.sql"
diff "$SCRATCH/dump_migration.sql" "$SCRATCH/dump_reference.sql"
```

Expected: `diff` exits 0 with empty output — **zero differences is the acceptance criterion**.

If there are differences:
- Name deltas (constraint/index named differently) → fix the explicit name in `src/schema.ts`.
- Type/default/nullability deltas → fix the column definition in `src/schema.ts`.
- Then: delete `packages/db/migrations/` contents, `pnpm --filter @pet-crypto/db build`, regenerate (Task 6 Step 1), re-run Steps 2–3 of this task (drop and recreate both databases first: `docker exec schema_parity psql -U postgres -c 'DROP DATABASE from_migration' -c 'DROP DATABASE from_reference'`, then repeat from Step 1's CREATE DATABASE command). Commit the fix as `fix(db): align schema with reference DDL (parity diff)`.

- [ ] **Step 4: Tear down**

```bash
docker rm -f schema_parity
```

- [ ] **Step 5: Full root pipeline**

Run from the repo root, in order:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm depcruise
```

Expected: all exit 0 (`depcruise` needs the fresh `pnpm build` — that ordering is already in the command). `pnpm test` passes via `--passWithNoTests`.

- [ ] **Step 6: Record the parity result**

If Step 3 required no fixes, make an empty-change record by amending nothing — instead append the evidence to the final commit of the branch: create commit only if files changed. If nothing changed after Task 6's commit, record the verification in the commit message of a docs touch-up:

```bash
git commit --allow-empty -m "chore(db): parity verified — migration 0000 vs schema.sql pg_dump diff is empty on postgres:16"
```

---

## Self-review notes (run after writing, fixed inline)

- **Spec coverage:** package layout (Tasks 1–5), column mapping table (Tasks 1–5 code), constraint/index parity (explicit names throughout + Task 7 diff loop), migration workflow scripts (Task 5 Step 4), verification/acceptance (Task 7), non-goals untouched (no repositories, no compose wiring, no seeds, no branded types). ✓
- **Type consistency:** `exportsTable`/`toolCalls`/`integrationCredentials` names consistent between Task 5 code and index re-export (`export * from './schema.js'` covers them); `createDb`/`Db` consistent between client.ts and index.ts. FK count stated as 23 in Task 6 matches the foreignKey() calls defined across Tasks 1–5 (clients 1, wallets 2, api_keys 1, chain_events 1, price_snapshots 1, entities 2, entity_addresses 2, external_records 4, matches 5, tool_calls 1, integration_credentials 1, exports 2). ✓
- **Placeholders:** none — every code step carries full content; commands carry expected output. ✓

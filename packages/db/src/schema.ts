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

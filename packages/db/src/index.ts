/**
 * Drizzle schema, pool/client wiring, migrations and tenant bootstrap. It holds no
 * repositories — the tenant-owned ones live in `mcp-tools`, and ledger reads take an
 * address set resolved from the tenant's wallets one layer up (ADR-006 d2, amended
 * 2026-09-15). Tenant identity comes from the transport session, never from tool arguments.
 */
export * from './schema.js';
export { createDb, type Db, type Tx } from './client.js';
export { runMigrations } from './migrate.js';
export { ensureSelfHostTenant } from './tenants.js';

/**
 * Per-call context. Tenant identity comes from the transport session (ADR-012)
 * and is injected here — never read from tool arguments (ADR-006). Every tool is
 * `(ctx, input)`, and every repository read is scoped to `ctx.tenantId`.
 */
import type { Db, Tx } from '@reconcil/db';

export interface ToolContext {
  db: Db;
  tenantId: string;
}

/**
 * A context whose handle is an open transaction (the write-tool helper hands this to a
 * write's body and to `persistToolCall`, so the mutation and its audit row commit atomically).
 */
export interface TxContext {
  db: Tx;
  tenantId: string;
}

/**
 * Either handle. Shared write plumbing (`persistToolCall` and the write repositories) is
 * typed against this supertype so it runs identically at top level (`Db`) or inside the
 * atomicity helper's transaction (`Tx`) — widening a parameter to it breaks no existing caller.
 *
 * Caveat for a future drizzle bump: calling a method on the `Db | Tx` union (notably
 * `.transaction()`, which suggestMatches/upsertEntity invoke to nest a savepoint) only
 * type-resolves while both handles keep structurally identical signatures. If a drizzle
 * upgrade diverges them, narrow at the call site (e.g. accept `Tx` there) rather than widening.
 */
export interface DbContext {
  db: Db | Tx;
  tenantId: string;
}

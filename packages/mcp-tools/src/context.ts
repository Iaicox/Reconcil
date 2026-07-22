/**
 * Per-call context. Tenant identity comes from the transport session (ADR-012)
 * and is injected here — never read from tool arguments (ADR-006). Every tool is
 * `(ctx, input)`, and every repository read is scoped to `ctx.tenantId`.
 */
import type { Db } from '@pet-crypto/db';

export interface ToolContext {
  db: Db;
  tenantId: string;
}

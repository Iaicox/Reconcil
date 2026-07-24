/**
 * Tenant resolution helpers. `ensureSelfHostTenant` resolves the single self-host tenant
 * (P10), creating it on first run from config so a fresh container just works with no
 * manual seeding. It is one of the few un-tenant-scoped queries allowed — it *establishes*
 * the tenant that every downstream repository read is then scoped to (ADR-006). Consumed by
 * the mcp-server stdio boot and the CLI demo REPL alike; tenancy is db-owned, so it lives
 * here rather than in any single app.
 */
import type { Db } from './client.js';
import { tenants } from './schema.js';

/** Idempotent upsert of the self-host tenant by slug; returns its id. */
export async function ensureSelfHostTenant(db: Db, slug: string, name: string): Promise<string> {
  const rows = await db
    .insert(tenants)
    .values({ slug, name })
    .onConflictDoUpdate({ target: tenants.slug, set: { name } })
    .returning({ id: tenants.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('ensureSelfHostTenant: upsert returned no row');
  return id;
}

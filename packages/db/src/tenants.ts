/**
 * Tenant resolution helpers. `ensureSelfHostTenant` resolves the single self-host tenant
 * (P10), creating it on first run from config so a fresh container just works with no
 * manual seeding. It is one of the few un-tenant-scoped queries allowed — it *establishes*
 * the tenant that every downstream repository read is then scoped to (ADR-006). Consumed by
 * the mcp-server stdio boot and the CLI demo REPL alike; tenancy is db-owned, so it lives
 * here rather than in any single app.
 */
import { eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { tenants } from './schema.js';

/**
 * Idempotent upsert of the self-host tenant by slug; returns its id. `name` is set on
 * INSERT only — `onConflictDoUpdate({ set: { name } })` looked idempotent but actually
 * rewrote `name` on every container boot, silently reverting a rename made through any
 * other path (e.g. a future settings UI) back to the config value. `onConflictDoNothing`
 * means an existing row is left untouched; the fallback SELECT covers the case where this
 * call lost the insert race (another boot/replica created the row first) so the caller
 * still gets an id instead of a thrown error.
 */
export async function ensureSelfHostTenant(db: Db, slug: string, name: string): Promise<string> {
  const inserted = await db
    .insert(tenants)
    .values({ slug, name })
    .onConflictDoNothing({ target: tenants.slug })
    .returning({ id: tenants.id });
  const insertedId = inserted[0]?.id;
  if (insertedId !== undefined) return insertedId;

  const existing = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
  const id = existing[0]?.id;
  if (id === undefined) throw new Error('ensureSelfHostTenant: upsert returned no row');
  return id;
}

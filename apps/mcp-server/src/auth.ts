/**
 * Transport → tenant boundary (ADR-006/012). These are the only lookups allowed
 * to run un-tenant-scoped: they *establish* the tenant that every downstream
 * repository read is then scoped to. Tenant identity is never a tool argument.
 */
import { createHash } from 'node:crypto';

import { apiKeys, tenants, type Db } from '@pet-crypto/db';
import { and, eq, isNull } from 'drizzle-orm';

/** sha256 hex of a presented bearer key — matches `api_keys.key_hash` (plaintext never stored). */
export function hashKey(presentedKey: string): string {
  return createHash('sha256').update(presentedKey).digest('hex');
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header, or null if the
 * header is absent or not a Bearer credential. The scheme match is case-insensitive
 * (RFC 7235 §2.1: auth schemes are case-insensitive) so a compliant `bearer …`
 * client is not spuriously rejected.
 *
 * A linear prefix-test + slice rather than a `\s+(.+)` regex: the two overlapping
 * quantifiers over whitespace are a polynomial-ReDoS shape on the attacker-controlled
 * Authorization header (CodeQL js/polynomial-redos). `^Bearer\s` has no quantifier.
 */
export function parseBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  if (!/^Bearer\s/i.test(header)) return null;
  const token = header.slice('Bearer'.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve the tenant behind a presented bearer key, or null for an unknown or
 * revoked key. The caller answers 401 without distinguishing the two — a missing
 * key and a wrong key are indistinguishable to the client (no oracle).
 */
export async function resolveTenantByBearer(db: Db, presentedKey: string): Promise<string | null> {
  const rows = await db
    .select({ tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashKey(presentedKey)), isNull(apiKeys.revokedAt)))
    .limit(1);
  return rows[0]?.tenantId ?? null;
}

/**
 * Idempotent self-host tenant (P10: single-tenant self-host). The stdio entry
 * resolves its fixed tenant through here on boot, creating it on first run so a
 * fresh container just works with no manual seeding.
 */
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

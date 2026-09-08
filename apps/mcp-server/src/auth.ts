/**
 * Transport → tenant boundary (ADR-006/012). These are the only lookups allowed
 * to run un-tenant-scoped: they *establish* the tenant that every downstream
 * repository read is then scoped to. Tenant identity is never a tool argument.
 */
import { createHash } from 'node:crypto';

import { apiKeys, type Db } from '@reconcil/db';
import { and, eq, isNull, or, gt, lt, sql } from 'drizzle-orm';

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
 * How stale `last_used_at` may get before a request refreshes it. Stamping every request
 * would put a write on the hot path of every authenticated call; the question this column
 * answers — "is this key still in use, and roughly when was it last seen" — does not need
 * per-request resolution. So the common case stays a single SELECT and only a request that
 * finds the stamp stale pays for the UPDATE.
 */
export const LAST_USED_REFRESH_MS = 5 * 60_000;

/**
 * Resolve the tenant behind a presented bearer key, or null for an unknown, revoked or
 * EXPIRED key. The caller answers 401 without distinguishing them — a missing key, a wrong
 * key and a key that ran out are all indistinguishable to the client (no oracle). Expiry
 * had to join that set rather than get its own status for exactly that reason.
 *
 * Also records that the key was used (ADR-012 Consequences, amended): a bearer key whose
 * use is invisible cannot be noticed being used by someone other than its holder, and
 * cannot be identified as unused and safe to rotate.
 */
export async function resolveTenantByBearer(db: Db, presentedKey: string): Promise<string | null> {
  const keyHash = hashKey(presentedKey);
  const rows = await db
    .select({ tenantId: apiKeys.tenantId, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyHash, keyHash),
        isNull(apiKeys.revokedAt),
        // NULL expires_at is the non-expiring key ADR-012 originally described, and stays
        // valid — this is opt-in per key, not a deadline retrofitted onto existing ones.
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, sql`now()`)),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  const cutoff = new Date(Date.now() - LAST_USED_REFRESH_MS);
  if (row.lastUsedAt === null || row.lastUsedAt < cutoff) {
    // Guarded in SQL as well as in the branch above: two concurrent requests can both read
    // a stale stamp, and the predicate keeps the second one from being a pointless write.
    await db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(apiKeys.keyHash, keyHash),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, cutoff)),
        ),
      );
  }
  return row.tenantId;
}

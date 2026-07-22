/**
 * Entity resolution over the address book (directory_*, §6.3). Given (address,
 * chain?) refs, exact-match `entity_addresses ⋈ entities` within the tenant plus
 * curated (`tenant_id NULL`) rows, then pick the best label deterministically:
 * tenant rows shadow curated, a chain-specific row shadows a chain-agnostic
 * (`chain_id NULL`) one, then lowest `entity_id`. The tool labels a bare address;
 * it never invents names (P1). Read-only, tenant-scoped (ADR-006).
 */
import { entities, entityAddresses } from '@pet-crypto/db';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import type { ToolContext } from '../context.js';

export interface ResolvedEntity {
  entityId: string;
  name: string;
  kind: string;
  curated: boolean;
}

export interface EntityRef {
  address: string;
  chainId?: number;
}

/** Lookup key for the resolved map: address, qualified by chain when one is known. */
export function refKey(address: string, chainId?: number): string {
  const a = address.toLowerCase();
  return chainId === undefined ? a : `${a}#${String(chainId)}`;
}

interface Candidate {
  address: string;
  chainId: number | null;
  tenantId: string | null;
  entityId: string;
  name: string;
  kind: string;
}

/** Ordering rank for a candidate against a ref (lower = preferred). */
function rank(c: Candidate, chainId?: number): [number, number, string] {
  const tenantScore = c.tenantId !== null ? 0 : 1; // tenant shadows curated
  const chainScore =
    chainId !== undefined && c.chainId === chainId ? 0 : c.chainId === null ? 1 : 2; // chain-specific shadows NULL
  return [tenantScore, chainScore, c.entityId];
}

function better(a: [number, number, string], b: [number, number, string]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/**
 * Resolve each requested ref to at most one entity. The returned map is keyed by
 * `refKey(address, chainId)` — callers look up with the same address/chain pair.
 */
export async function resolveEntities(
  ctx: ToolContext,
  refs: EntityRef[],
): Promise<Map<string, ResolvedEntity>> {
  const out = new Map<string, ResolvedEntity>();
  const addrs = [...new Set(refs.map((r) => r.address.toLowerCase()))];
  if (addrs.length === 0) return out;

  const candidates: Candidate[] = await ctx.db
    .select({
      address: entityAddresses.address,
      chainId: entityAddresses.chainId,
      tenantId: entityAddresses.tenantId,
      entityId: entities.id,
      name: entities.name,
      kind: entities.kind,
    })
    .from(entityAddresses)
    .innerJoin(entities, eq(entities.id, entityAddresses.entityId))
    .where(
      and(
        inArray(entityAddresses.address, addrs),
        or(eq(entityAddresses.tenantId, ctx.tenantId), isNull(entityAddresses.tenantId)),
      ),
    );

  // Unique refs by (address, chain) — the same pair resolves once.
  const seen = new Set<string>();
  for (const ref of refs) {
    const addr = ref.address.toLowerCase();
    const key = refKey(addr, ref.chainId);
    if (seen.has(key)) continue;
    seen.add(key);

    let best: Candidate | undefined;
    let bestRank: [number, number, string] | undefined;
    for (const c of candidates) {
      if (c.address !== addr) continue;
      // A chain-specific candidate applies only when the ref's chain matches (or is unknown).
      if (ref.chainId !== undefined && c.chainId !== null && c.chainId !== ref.chainId) continue;
      const r = rank(c, ref.chainId);
      if (best === undefined || better(r, bestRank!)) {
        best = c;
        bestRank = r;
      }
    }
    if (best !== undefined) {
      out.set(key, { entityId: best.entityId, name: best.name, kind: best.kind, curated: best.tenantId === null });
    }
  }
  return out;
}

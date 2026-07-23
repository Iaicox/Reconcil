/**
 * Resolve a `Scope` (contract §5) to concrete tracked addresses, always within
 * `ctx.tenantId` (ADR-006: a tool can never reach another tenant's data). Scope
 * fields intersect; default (no scope) = all of the tenant's wallets. Unknown
 * wallet ids / untracked addresses are loud domain errors, not silent empties.
 */
import { clients, wallets } from '@pet-crypto/db';
import { eq, sql } from 'drizzle-orm';

import type { Scope } from '@pet-crypto/core';

import type { ToolContext } from './context.js';
import { ToolError } from './errors.js';

export interface ResolvedScope {
  addresses: string[]; // lowercase, tenant-tracked
}

/**
 * Validate a caller-supplied `client_id` belongs to the session tenant (ADR-006).
 * `undefined` → `null` (single-company mode). `clients.id::text` is canonical
 * lowercase, so a non-UUID / unknown / other-tenant value all fall through to
 * "no row" → INVALID_INPUT — never a raw Postgres uuid-cast error, and never a
 * silent cross-tenant attachment. Returns the canonical id to store.
 */
export async function resolveClientId(ctx: ToolContext, clientId?: string): Promise<string | null> {
  if (clientId === undefined) return null;
  const rows = await ctx.db
    .select({ id: clients.id })
    .from(clients)
    .where(sql`${clients.id}::text = ${clientId.toLowerCase()} and ${clients.tenantId} = ${ctx.tenantId}`)
    .limit(1);
  if (rows.length === 0) throw new ToolError('INVALID_INPUT', `unknown client_id: ${clientId}`);
  return rows[0]!.id;
}

export async function resolveScope(ctx: ToolContext, scope?: Scope): Promise<ResolvedScope> {
  const rows = await ctx.db
    .select({ id: wallets.id, address: wallets.address, clientId: wallets.clientId })
    .from(wallets)
    .where(eq(wallets.tenantId, ctx.tenantId));

  let picked = rows;

  if (scope?.client_id !== undefined) {
    picked = picked.filter((r) => r.clientId === scope.client_id);
  }

  if (scope?.wallet_ids !== undefined && scope.wallet_ids.length > 0) {
    const want = new Set(scope.wallet_ids);
    const have = new Set(rows.map((r) => r.id));
    for (const id of scope.wallet_ids) {
      if (!have.has(id)) throw new ToolError('UNKNOWN_SCOPE', `wallet_id not in tenant: ${id}`);
    }
    picked = picked.filter((r) => want.has(r.id));
  }

  if (scope?.addresses !== undefined && scope.addresses.length > 0) {
    const want = scope.addresses.map((a) => a.toLowerCase());
    const have = new Set(rows.map((r) => r.address));
    for (const a of want) {
      if (!have.has(a)) {
        throw new ToolError('WALLET_NOT_TRACKED', `address not tracked: ${a}`, 'call ledger_track_wallet first');
      }
    }
    const wantSet = new Set(want);
    picked = picked.filter((r) => wantSet.has(r.address));
  }

  const addresses = [...new Set(picked.map((r) => r.address))];
  if (addresses.length === 0) {
    throw new ToolError('COVERAGE_EMPTY', 'no tracked wallets in scope');
  }
  return { addresses };
}

/**
 * Resolve a `Scope` (contract §5) to concrete tracked addresses, always within
 * `ctx.tenantId` (ADR-006: a tool can never reach another tenant's data). Scope
 * fields intersect; default (no scope) = all of the tenant's wallets. Unknown
 * wallet ids / untracked addresses are loud domain errors, not silent empties.
 */
import { wallets } from '@pet-crypto/db';
import { eq } from 'drizzle-orm';

import type { Scope } from '@pet-crypto/core';

import type { ToolContext } from './context.js';
import { ToolError } from './errors.js';

export interface ResolvedScope {
  addresses: string[]; // lowercase, tenant-tracked
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

/**
 * Flows restricted to verified stablecoins — the single most common accountant
 * question, so it gets a stable contract. Thin wrapper over computeFlows: resolve
 * the stablecoin token-id set (optionally one peg), then reuse the flow fold.
 * Per-peg *fiat* subtotals need valuation and are composed above ledger (pricing).
 */
import { tokens, type Db } from '@pet-crypto/db';
import { and, eq, inArray } from 'drizzle-orm';

import { computeFlows } from './flows.js';
import type { FlowsParams, FlowsResult, StablecoinParams } from './types.js';

export async function computeStablecoinMovements(db: Db, p: StablecoinParams): Promise<FlowsResult> {
  const conds = [eq(tokens.isStablecoin, true), eq(tokens.verified, true)];
  if (p.pegCurrency) conds.push(eq(tokens.pegCurrency, p.pegCurrency));
  if (p.chainIds && p.chainIds.length > 0) conds.push(inArray(tokens.chainId, p.chainIds));

  const ids = (await db.select({ id: tokens.id }).from(tokens).where(and(...conds))).map((r) => r.id);
  if (ids.length === 0) return { rows: [], internal: [] };

  const params: FlowsParams = {
    scope: p.scope,
    period: p.period,
    restrictTokenIds: ids,
    ...(p.chainIds ? { chainIds: p.chainIds } : {}),
    ...(p.direction ? { direction: p.direction } : {}),
    ...(p.groupBy ? { groupBy: p.groupBy } : {}),
  };
  return computeFlows(db, params);
}

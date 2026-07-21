/**
 * Inbound/outbound/net movements over a period, grouped by token. Self-transfers
 * between two in-scope wallets are reported in a separate `internal` group, never
 * as external flow (classic accounting pitfall). Excludes `gas_fee` (see
 * computeGas) and `opening_balance`. Aggregate raw in SQL, scale at the edge.
 */
import { formatUnits } from '@pet-crypto/core';
import { chainEvents, type Db } from '@pet-crypto/db';
import { and, inArray, or, sql } from 'drizzle-orm';

import { bucketBacking, emptyBacking } from './backing.js';
import {
  chainFilter,
  externalCondition,
  internalCondition,
  periodRange,
  timeBetween,
  transferKinds,
} from './scope-sql.js';
import { loadTokenMeta } from './token-meta.js';
import type { FlowRow, FlowsParams, FlowsResult, TokenMeta } from './types.js';

interface Agg {
  tokenId: number;
  inflow: string;
  outflow: string;
  tx: number;
}

export async function computeFlows(db: Db, p: FlowsParams): Promise<FlowsResult> {
  const addresses = p.scope.addresses.map((a) => a.toLowerCase());
  if (addresses.length === 0) return { rows: [], internal: [] };
  const direction = p.direction ?? 'both';
  const { from, to } = periodRange(p.period);

  const restrict = p.restrictTokenIds && p.restrictTokenIds.length > 0
    ? inArray(chainEvents.tokenId, p.restrictTokenIds)
    : undefined;
  const base = and(transferKinds(), timeBetween(from, to), chainFilter(p.chainIds), restrict);
  const inflowExpr = sql<string>`coalesce(sum(case when ${inArray(chainEvents.toAddr, addresses)} then ${chainEvents.amountRaw} else 0 end),0)`;
  const outflowExpr = sql<string>`coalesce(sum(case when ${inArray(chainEvents.fromAddr, addresses)} then ${chainEvents.amountRaw} else 0 end),0)`;
  const txExpr = sql<number>`count(distinct ${chainEvents.txHash})::int`;
  const select = { tokenId: chainEvents.tokenId, inflow: inflowExpr, outflow: outflowExpr, tx: txExpr };

  const extAgg = await db
    .select(select)
    .from(chainEvents)
    .where(and(base, externalCondition(addresses, direction)))
    .groupBy(chainEvents.tokenId);
  const intAgg = await db
    .select(select)
    .from(chainEvents)
    .where(and(base, internalCondition(addresses)))
    .groupBy(chainEvents.tokenId);

  const tokenIds = [...new Set([...extAgg, ...intAgg].map((r) => r.tokenId))];
  const metaById = await loadTokenMeta(db, tokenIds);

  // Backing: one ordered fetch of the same event set, bucketed by (token, kind).
  const refRows = await db
    .select({
      chainId: chainEvents.chainId,
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      tokenId: chainEvents.tokenId,
      fromAddr: chainEvents.fromAddr,
      toAddr: chainEvents.toAddr,
    })
    .from(chainEvents)
    .where(and(base, or(externalCondition(addresses, direction), internalCondition(addresses))))
    .orderBy(chainEvents.chainId, chainEvents.blockNumber, chainEvents.logIndex, chainEvents.id);
  const S = new Set(addresses);
  const isInternal = (r: { fromAddr: string; toAddr: string }): boolean => S.has(r.fromAddr) && S.has(r.toAddr);
  const extBacking = bucketBacking(refRows.filter((r) => !isInternal(r)), (r) => [String(r.tokenId)]);
  const intBacking = bucketBacking(refRows.filter(isInternal), (r) => [String(r.tokenId)]);

  return {
    rows: buildRows(extAgg, metaById, extBacking, p.includeUnverified ?? false),
    internal: buildRows(intAgg, metaById, intBacking, p.includeUnverified ?? false),
  };
}

function buildRows(
  aggs: Agg[],
  metaById: Map<number, TokenMeta>,
  backing: Map<string, ReturnType<typeof emptyBacking>>,
  includeUnverified: boolean,
): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const a of aggs) {
    const token = metaById.get(a.tokenId);
    if (!token) continue;
    if (!includeUnverified && !token.verified) continue;
    const inflow = BigInt(a.inflow);
    const outflow = BigInt(a.outflow);
    if (inflow === 0n && outflow === 0n) continue;
    const net = inflow - outflow;
    rows.push({
      tokenId: a.tokenId,
      token,
      group: { token: token.symbolDisplay ?? String(a.tokenId) },
      inflowRaw: inflow.toString(),
      inflow: formatUnits(inflow, token.decimals),
      outflowRaw: outflow.toString(),
      outflow: formatUnits(outflow, token.decimals),
      netRaw: net.toString(),
      net: formatUnits(net, token.decimals),
      txCount: a.tx,
      backing: backing.get(String(a.tokenId)) ?? emptyBacking(),
    });
  }
  rows.sort((x, y) => x.tokenId - y.tokenId);
  return rows;
}

/**
 * Inbound/outbound/net movements over a period, grouped by token and optionally
 * subdivided by counterparty/day/month. `token` is always a grouping dimension —
 * raw inflow/outflow are base-unit sums, meaningful only per token (ADR-004) — so
 * `groupBy` adds finer buckets, it never drops token. Self-transfers between two
 * in-scope wallets are reported in a separate `internal` group, never as external
 * flow (classic accounting pitfall). Excludes `gas_fee` (see computeGas) and
 * `opening_balance`. Aggregate raw in SQL, scale at the edge.
 */
import { formatUnits } from '@pet-crypto/core';
import { chainEvents, type Db } from '@pet-crypto/db';
import { type SQL, and, inArray, or, sql } from 'drizzle-orm';

import { bucketBacking, emptyBacking } from './backing.js';
import {
  chainFilter,
  counterpartyExpr,
  externalCondition,
  internalCondition,
  periodRange,
  timeBetween,
  transferKinds,
} from './scope-sql.js';
import { loadTokenMeta } from './token-meta.js';
import type { FlowGroupBy, FlowRow, FlowsParams, FlowsResult, TokenMeta } from './types.js';

/** Canonical dimension order — key components and group records both follow it. */
const DIM_ORDER: readonly FlowGroupBy[] = ['token', 'counterparty', 'day', 'month'] as const;

/** Always include `token`; dedupe; return in canonical order. */
function normalizeGroupBy(groupBy?: FlowGroupBy[]): FlowGroupBy[] {
  const set = new Set<FlowGroupBy>(['token']);
  for (const d of groupBy ?? []) set.add(d);
  return DIM_ORDER.filter((d) => set.has(d));
}

/** One aggregate bucket; dim fields present only when that dim is grouped. */
interface Agg {
  tokenId: number;
  cp?: string;
  day?: string;
  month?: string;
  inflow: string;
  outflow: string;
  tx: number;
}

export async function computeFlows(db: Db, p: FlowsParams): Promise<FlowsResult> {
  const addresses = p.scope.addresses.map((a) => a.toLowerCase());
  if (addresses.length === 0) return { rows: [], internal: [] };
  const direction = p.direction ?? 'both';
  const dims = normalizeGroupBy(p.groupBy);
  const { from, to } = periodRange(p.period);

  const restrict = p.restrictTokenIds && p.restrictTokenIds.length > 0
    ? inArray(chainEvents.tokenId, p.restrictTokenIds)
    : undefined;
  const base = and(transferKinds(), timeBetween(from, to), chainFilter(p.chainIds), restrict);
  const inflowExpr = sql<string>`coalesce(sum(case when ${inArray(chainEvents.toAddr, addresses)} then ${chainEvents.amountRaw} else 0 end),0)`;
  const outflowExpr = sql<string>`coalesce(sum(case when ${inArray(chainEvents.fromAddr, addresses)} then ${chainEvents.amountRaw} else 0 end),0)`;
  const txExpr = sql<number>`count(distinct ${chainEvents.txHash})::int`;

  // Sub-dimension select columns (token is carried by tokenId, always present). The
  // select-key + SQL for each; the leading dimension columns are derived from the
  // canonical `dims` so `dims[i]` lines up with output ordinal `i+1` by construction.
  const SUBDIM: Record<'counterparty' | 'day' | 'month', { key: string; expr: SQL }> = {
    counterparty: { key: 'cp', expr: counterpartyExpr(addresses) },
    day: { key: 'day', expr: sql<string>`to_char(${chainEvents.blockTime} AT TIME ZONE 'UTC', 'YYYY-MM-DD')` },
    month: { key: 'month', expr: sql<string>`to_char(${chainEvents.blockTime} AT TIME ZONE 'UTC', 'YYYY-MM')` },
  };
  const subCols = Object.fromEntries(
    dims.filter((d): d is 'counterparty' | 'day' | 'month' => d !== 'token').map((d) => [SUBDIM[d].key, SUBDIM[d].expr]),
  );
  const select = { tokenId: chainEvents.tokenId, ...subCols, inflow: inflowExpr, outflow: outflowExpr, tx: txExpr };
  // Group by output-column ordinals: the leading `dims.length` select items are exactly
  // the dimension columns, in canonical order (derived above). Grouping by the
  // parameterized counterparty CASE expression textually would mint fresh `$n`
  // placeholders that Postgres treats as a different expression from the SELECT copy —
  // ordinals dodge that.
  const groupCols: SQL[] = dims.map((_, i) => sql.raw(String(i + 1)));

  const runAgg = async (cond: SQL): Promise<Agg[]> => {
    const rows = await db.select(select).from(chainEvents).where(and(base, cond)).groupBy(...groupCols);
    return rows as unknown as Agg[];
  };
  const extAgg = await runAgg(externalCondition(addresses, direction));
  const intAgg = await runAgg(internalCondition(addresses));

  const tokenIds = [...new Set([...extAgg, ...intAgg].map((r) => r.tokenId))];
  const metaById = await loadTokenMeta(db, tokenIds);

  // Backing: one ordered fetch of the same event set, bucketed by the composite
  // group key (computed in JS so it matches the SQL grouping exactly).
  const refRows = await db
    .select({
      chainId: chainEvents.chainId,
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      tokenId: chainEvents.tokenId,
      fromAddr: chainEvents.fromAddr,
      toAddr: chainEvents.toAddr,
      blockTime: chainEvents.blockTime,
    })
    .from(chainEvents)
    .where(and(base, or(externalCondition(addresses, direction), internalCondition(addresses))))
    .orderBy(chainEvents.chainId, chainEvents.blockNumber, chainEvents.logIndex, chainEvents.id);
  const S = new Set(addresses);
  const isInternal = (r: { fromAddr: string; toAddr: string }): boolean => S.has(r.fromAddr) && S.has(r.toAddr);
  const refKey = (r: { tokenId: number; fromAddr: string; toAddr: string; blockTime: Date }): string[] => [
    keyOf(dims, {
      tokenId: r.tokenId,
      cp: S.has(r.fromAddr) ? r.toAddr : r.fromAddr,
      day: r.blockTime.toISOString().slice(0, 10),
      month: r.blockTime.toISOString().slice(0, 7),
    }),
  ];
  const extBacking = bucketBacking(refRows.filter((r) => !isInternal(r)), refKey);
  const intBacking = bucketBacking(refRows.filter(isInternal), refKey);

  return {
    rows: buildRows(extAgg, metaById, extBacking, p.includeUnverified ?? false, dims),
    internal: buildRows(intAgg, metaById, intBacking, p.includeUnverified ?? false, dims),
  };
}

/** Composite bucket key over the selected dims, in canonical order. */
function keyOf(dims: FlowGroupBy[], v: { tokenId: number; cp: string; day: string; month: string }): string {
  return dims
    .map((d) => (d === 'token' ? String(v.tokenId) : d === 'counterparty' ? v.cp : d === 'day' ? v.day : v.month))
    .join('|');
}

function groupRecord(dims: FlowGroupBy[], a: Agg, token: TokenMeta): Record<string, string> {
  const g: Record<string, string> = {};
  for (const d of dims) {
    if (d === 'token') {
      // chain_id keeps same-symbol tokens on different chains distinct on the wire
      // (the composite bucket key is tokenId-based, so this is presentational only).
      g.token = token.symbolDisplay ?? String(a.tokenId);
      g.chain_id = String(token.chainId);
    } else if (d === 'counterparty') g.counterparty = a.cp ?? '';
    else if (d === 'day') g.day = a.day ?? '';
    else if (d === 'month') g.month = a.month ?? '';
  }
  return g;
}

function buildRows(
  aggs: Agg[],
  metaById: Map<number, TokenMeta>,
  backing: Map<string, ReturnType<typeof emptyBacking>>,
  includeUnverified: boolean,
  dims: FlowGroupBy[],
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
    const key = keyOf(dims, { tokenId: a.tokenId, cp: a.cp ?? '', day: a.day ?? '', month: a.month ?? '' });
    rows.push({
      tokenId: a.tokenId,
      token,
      group: groupRecord(dims, a, token),
      inflowRaw: inflow.toString(),
      inflow: formatUnits(inflow, token.decimals),
      outflowRaw: outflow.toString(),
      outflow: formatUnits(outflow, token.decimals),
      netRaw: net.toString(),
      net: formatUnits(net, token.decimals),
      txCount: a.tx,
      backing: backing.get(key) ?? emptyBacking(),
    });
  }
  rows.sort((x, y) =>
    x.tokenId - y.tokenId
    || keyOf(dims, { tokenId: x.tokenId, cp: x.group.counterparty ?? '', day: x.group.day ?? '', month: x.group.month ?? '' })
      .localeCompare(keyOf(dims, { tokenId: y.tokenId, cp: y.group.counterparty ?? '', day: y.group.day ?? '', month: y.group.month ?? '' })),
  );
  return rows;
}

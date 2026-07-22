/**
 * Fee spend: sums `gas_fee` events (native token, from = payer) over a period.
 * `chain` is an always-on grouping dimension — the native fee token is per-chain,
 * so raw sums are meaningful only per chain (cf. `token` in flows, ADR-004) —
 * `wallet` (the payer) and `month` subdivide. Same fold, same citations as any
 * other flow (ADR-005: gas is an event). Natives are always shown (no verified
 * filter). Aggregate raw in SQL, scale at the edge.
 */
import { formatUnits } from '@pet-crypto/core';
import { chainEvents, type Db } from '@pet-crypto/db';
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm';

import { bucketBacking, emptyBacking } from './backing.js';
import { chainFilter, periodRange, timeBetween } from './scope-sql.js';
import { loadTokenMeta } from './token-meta.js';
import type { GasGroupBy, GasParams, GasRow } from './types.js';

/** Canonical dimension order; `chain` (carried by tokenId/chainId) is always first. */
const GAS_DIM_ORDER: readonly GasGroupBy[] = ['chain', 'wallet', 'month'] as const;

/** Always include `chain`; dedupe; return in canonical order. */
function normalizeGroupBy(groupBy?: GasGroupBy[]): GasGroupBy[] {
  const set = new Set<GasGroupBy>(['chain']);
  for (const d of groupBy ?? []) set.add(d);
  return GAS_DIM_ORDER.filter((d) => set.has(d));
}

interface GasAgg {
  tokenId: number;
  chainId: number;
  wallet?: string;
  month?: string;
  amount: string;
  tx: number;
}

/** UTC year-month bucket, matching the SQL `to_char(... 'YYYY-MM')`. */
const monthOf = (t: Date): string => t.toISOString().slice(0, 7);

/** Composite bucket key over the selected dims (chain ⇒ tokenId, 1:1 with chain). */
function keyOf(dims: GasGroupBy[], v: { tokenId: number; wallet: string; month: string }): string {
  return dims.map((d) => (d === 'chain' ? String(v.tokenId) : d === 'wallet' ? v.wallet : v.month)).join('|');
}

export async function computeGas(db: Db, p: GasParams): Promise<GasRow[]> {
  const addresses = p.scope.addresses.map((a) => a.toLowerCase());
  if (addresses.length === 0) return [];
  const { from, to } = periodRange(p.period);
  const dims = normalizeGroupBy(p.groupBy);
  const wantWallet = dims.includes('wallet');
  const wantMonth = dims.includes('month');

  const base = and(
    eq(chainEvents.eventKind, 'gas_fee'),
    inArray(chainEvents.fromAddr, addresses),
    timeBetween(from, to),
    chainFilter(p.chainIds),
  );

  const monthExpr = sql<string>`to_char(${chainEvents.blockTime} AT TIME ZONE 'UTC', 'YYYY-MM')`;
  // (tokenId, chainId) are always the leading select items — `chain` is always-on;
  // wallet/month follow. Group by output-column ordinals so the group set matches
  // the SELECT copies exactly (same technique as computeFlows).
  const select = {
    tokenId: chainEvents.tokenId,
    chainId: chainEvents.chainId,
    ...(wantWallet ? { wallet: chainEvents.fromAddr } : {}),
    ...(wantMonth ? { month: monthExpr } : {}),
    amount: sql<string>`coalesce(sum(${chainEvents.amountRaw}),0)`,
    tx: sql<number>`count(*)::int`,
  };
  const nDim = 2 + (wantWallet ? 1 : 0) + (wantMonth ? 1 : 0);
  const groupCols: SQL[] = Array.from({ length: nDim }, (_, i) => sql.raw(String(i + 1)));

  const rowsRaw = await db.select(select).from(chainEvents).where(base).groupBy(...groupCols);
  const agg = rowsRaw as unknown as GasAgg[];

  const tokenIds = [...new Set(agg.map((r) => r.tokenId))];
  const metaById = await loadTokenMeta(db, tokenIds);

  // Backing: one ordered fetch, bucketed by the same composite key (computed in JS
  // so it matches the SQL grouping exactly).
  const refRows = await db
    .select({
      chainId: chainEvents.chainId,
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      tokenId: chainEvents.tokenId,
      fromAddr: chainEvents.fromAddr,
      blockTime: chainEvents.blockTime,
    })
    .from(chainEvents)
    .where(base)
    .orderBy(chainEvents.chainId, chainEvents.blockNumber, chainEvents.logIndex, chainEvents.id);
  const backing = bucketBacking(refRows, (r) => [keyOf(dims, { tokenId: r.tokenId, wallet: r.fromAddr, month: monthOf(r.blockTime) })]);

  const rows: GasRow[] = [];
  for (const a of agg) {
    const token = metaById.get(a.tokenId);
    if (!token) continue;
    const amount = BigInt(a.amount);
    const group: Record<string, string> = { chain: String(a.chainId) };
    if (a.wallet !== undefined) group.wallet = a.wallet;
    if (a.month !== undefined) group.month = a.month;
    const key = keyOf(dims, { tokenId: a.tokenId, wallet: a.wallet ?? '', month: a.month ?? '' });
    rows.push({
      chainId: a.chainId,
      tokenId: a.tokenId,
      token,
      group,
      nativeAmountRaw: amount.toString(),
      nativeAmount: formatUnits(amount, token.decimals),
      txCount: a.tx,
      backing: backing.get(key) ?? emptyBacking(),
    });
  }
  rows.sort(
    (x, y) =>
      x.chainId - y.chainId
      || x.tokenId - y.tokenId
      || keyOf(dims, { tokenId: x.tokenId, wallet: x.group.wallet ?? '', month: x.group.month ?? '' })
        .localeCompare(keyOf(dims, { tokenId: y.tokenId, wallet: y.group.wallet ?? '', month: y.group.month ?? '' })),
  );
  return rows;
}

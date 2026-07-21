/**
 * Fee spend: sums `gas_fee` events (native token, from = payer) over a period,
 * grouped by chain. Same fold, same citations as any other flow (ADR-005 gas
 * is an event). Natives are always shown (no verified filter).
 */
import { formatUnits } from '@pet-crypto/core';
import { chainEvents, type Db } from '@pet-crypto/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { bucketBacking, emptyBacking } from './backing.js';
import { chainFilter, periodRange, timeBetween } from './scope-sql.js';
import { loadTokenMeta } from './token-meta.js';
import type { GasParams, GasRow } from './types.js';

export async function computeGas(db: Db, p: GasParams): Promise<GasRow[]> {
  const addresses = p.scope.addresses.map((a) => a.toLowerCase());
  if (addresses.length === 0) return [];
  const { from, to } = periodRange(p.period);

  const base = and(
    eq(chainEvents.eventKind, 'gas_fee'),
    inArray(chainEvents.fromAddr, addresses),
    timeBetween(from, to),
    chainFilter(p.chainIds),
  );

  const agg = await db
    .select({
      tokenId: chainEvents.tokenId,
      chainId: chainEvents.chainId,
      amount: sql<string>`coalesce(sum(${chainEvents.amountRaw}),0)`,
      tx: sql<number>`count(*)::int`,
    })
    .from(chainEvents)
    .where(base)
    .groupBy(chainEvents.tokenId, chainEvents.chainId);

  const tokenIds = [...new Set(agg.map((r) => r.tokenId))];
  const metaById = await loadTokenMeta(db, tokenIds);

  const refRows = await db
    .select({
      chainId: chainEvents.chainId,
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      tokenId: chainEvents.tokenId,
    })
    .from(chainEvents)
    .where(base)
    .orderBy(chainEvents.chainId, chainEvents.blockNumber, chainEvents.logIndex, chainEvents.id);
  const backing = bucketBacking(refRows, (r) => [String(r.tokenId)]);

  const rows: GasRow[] = [];
  for (const a of agg) {
    const token = metaById.get(a.tokenId);
    if (!token) continue;
    const amount = BigInt(a.amount);
    rows.push({
      chainId: a.chainId,
      tokenId: a.tokenId,
      token,
      group: { chain: String(a.chainId) },
      nativeAmountRaw: amount.toString(),
      nativeAmount: formatUnits(amount, token.decimals),
      txCount: a.tx,
      backing: backing.get(String(a.tokenId)) ?? emptyBacking(),
    });
  }
  rows.sort((x, y) => x.chainId - y.chainId || x.tokenId - y.tokenId);
  return rows;
}

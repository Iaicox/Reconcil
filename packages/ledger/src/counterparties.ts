/**
 * Turnover per counterparty (the non-scope endpoint) over external transfers in
 * a period. Per-token buckets — cross-token raw isn't summable and cross-token
 * value needs pricing, so ledger ranks `top_n` deterministically by activity
 * (`txCount` desc, address asc). Labeling (`entity_addresses`) lives above ledger.
 */
import { formatUnits } from '@pet-crypto/core';
import { chainEvents, tokens, type Db } from '@pet-crypto/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { bucketBacking, emptyBacking } from './backing.js';
import {
  chainFilter,
  counterpartyExpr,
  externalCondition,
  periodRange,
  timeBetween,
  transferKinds,
} from './scope-sql.js';
import { loadTokenMeta } from './token-meta.js';
import type {
  CounterpartiesParams,
  CounterpartiesResult,
  CounterpartyRow,
  CounterpartyTokenTurnover,
  TokenMeta,
} from './types.js';

export async function computeCounterparties(db: Db, p: CounterpartiesParams): Promise<CounterpartiesResult> {
  const addresses = p.scope.addresses.map((a) => a.toLowerCase());
  if (addresses.length === 0) return { rows: [], totalCounterparties: 0, truncatedCount: 0 };
  const direction = p.direction ?? 'both';
  const topN = p.topN ?? 20;
  const { from, to } = periodRange(p.period);

  const base = and(
    transferKinds(),
    timeBetween(from, to),
    chainFilter(p.chainIds),
    externalCondition(addresses, direction),
    p.includeUnverified ? undefined : eq(tokens.verified, true),
  );

  // Compute the counterparty (and per-direction amount) as plain columns in a
  // subquery, then group by them — grouping by the raw CASE expression trips
  // Postgres' ungrouped-column check (drizzle renders it twice).
  const sub = db
    .select({
      cp: counterpartyExpr(addresses).as('cp'),
      tokenId: chainEvents.tokenId,
      txHash: chainEvents.txHash,
      received: sql<string>`case when ${inArray(chainEvents.toAddr, addresses)} then ${chainEvents.amountRaw} else 0 end`.as('received'),
      sent: sql<string>`case when ${inArray(chainEvents.fromAddr, addresses)} then ${chainEvents.amountRaw} else 0 end`.as('sent'),
    })
    .from(chainEvents)
    .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
    .where(base)
    .as('sub');

  const perToken = await db
    .select({
      cp: sub.cp,
      tokenId: sub.tokenId,
      inflow: sql<string>`coalesce(sum(${sub.received}),0)`,
      outflow: sql<string>`coalesce(sum(${sub.sent}),0)`,
    })
    .from(sub)
    .groupBy(sub.cp, sub.tokenId);
  const perCp = await db
    .select({ cp: sub.cp, tx: sql<number>`count(distinct ${sub.txHash})::int` })
    .from(sub)
    .groupBy(sub.cp);

  const metaById = await loadTokenMeta(db, [...new Set(perToken.map((r) => r.tokenId))]);

  const refRows = await db
    .select({
      chainId: chainEvents.chainId,
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      fromAddr: chainEvents.fromAddr,
      toAddr: chainEvents.toAddr,
    })
    .from(chainEvents)
    .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
    .where(base)
    .orderBy(chainEvents.chainId, chainEvents.blockNumber, chainEvents.logIndex, chainEvents.id);
  const S = new Set(addresses);
  const backing = bucketBacking(refRows, (r) => [S.has(r.fromAddr) ? r.toAddr : r.fromAddr]);

  const txByCp = new Map(perCp.map((r) => [r.cp, r.tx]));
  const cpMap = new Map<string, { perToken: CounterpartyTokenTurnover[]; tokens: TokenMeta[] }>();
  for (const r of perToken) {
    const token = metaById.get(r.tokenId);
    if (!token) continue;
    const inflow = BigInt(r.inflow);
    const outflow = BigInt(r.outflow);
    let entry = cpMap.get(r.cp);
    if (!entry) { entry = { perToken: [], tokens: [] }; cpMap.set(r.cp, entry); }
    entry.perToken.push({
      token,
      inflowRaw: inflow.toString(),
      inflow: formatUnits(inflow, token.decimals),
      outflowRaw: outflow.toString(),
      outflow: formatUnits(outflow, token.decimals),
    });
    entry.tokens.push(token);
  }

  let rows: CounterpartyRow[] = [...cpMap].map(([address, e]) => ({
    address,
    perToken: e.perToken.sort((a, b) => a.token.tokenId - b.token.tokenId),
    tokens: e.tokens.sort((a, b) => a.tokenId - b.tokenId),
    txCount: txByCp.get(address) ?? 0,
    backing: backing.get(address) ?? emptyBacking(),
  }));
  rows.sort((a, b) => b.txCount - a.txCount || a.address.localeCompare(b.address));

  const totalCounterparties = rows.length;
  const truncatedCount = Math.max(0, totalCounterparties - topN);
  rows = rows.slice(0, topN);
  return { rows, totalCounterparties, truncatedCount };
}

/**
 * Paged event listing — the universal drilldown / citation target (C3). Keyset
 * pagination over the append-only store (`ORDER BY chain_id, block_number,
 * log_index, id`) is stable by construction; the cursor carries position only,
 * so callers must resend identical filters across pages. Amounts scaled once at
 * the edge (ADR-004); `min_amount` is the one sanctioned per-row numeric
 * threshold (never float).
 */
import { formatUnits } from '@pet-crypto/core';
import { chainEvents, tokens, type Db } from '@pet-crypto/db';
import { type SQL, and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from './cursor.js';
import { chainFilter, periodRange, timeBetween } from './scope-sql.js';
import type { EventListItem, ListEventsParams, ListEventsResult } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listEvents(db: Db, p: ListEventsParams): Promise<ListEventsResult> {
  const addresses = p.scope.addresses.map((a) => a.toLowerCase());
  if (addresses.length === 0) return { events: [], totalCount: 0 };
  const limit = Math.min(Math.max(1, p.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  // Domain-error boundary: mcp-tools owns full input validation, but guard the one
  // per-row numeric threshold here so a malformed value fails as a clean domain
  // error, never as a raw Postgres cast error deep in the query. `min_amount` is a
  // bound param (no injection) scaled per-token in SQL; this checks its shape only.
  if (p.minAmount !== undefined && !/^\d+(\.\d+)?$/.test(p.minAmount)) {
    throw new RangeError(`min_amount must be a non-negative decimal string, got: ${p.minAmount}`);
  }

  const scopeCond = or(inArray(chainEvents.fromAddr, addresses), inArray(chainEvents.toAddr, addresses));
  const periodCond = p.period ? (() => { const { from, to } = periodRange(p.period!); return timeBetween(from, to); })() : undefined;
  const kindCond = p.kinds && p.kinds.length > 0 ? inArray(chainEvents.eventKind, p.kinds) : undefined;
  const cpCond = p.counterpartyAddress
    ? or(eq(chainEvents.fromAddr, p.counterpartyAddress.toLowerCase()), eq(chainEvents.toAddr, p.counterpartyAddress.toLowerCase()))
    : undefined;
  const tokenCond = p.tokens && p.tokens.length > 0
    ? or(...p.tokens.map((t) => and(
        eq(tokens.chainId, t.chainId),
        t.address === null ? isNull(tokens.address) : eq(tokens.address, t.address.toLowerCase()),
      )))
    : undefined;
  const verifiedCond = p.includeUnverified ? undefined : eq(tokens.verified, true);
  // Scale the display threshold to base units. `10::numeric ^ decimals` is
  // numeric-exact for any decimals; float `power(10, …)` would only be exact by
  // luck for small exponents (ADR-004: never let money touch a float).
  const minCond = p.minAmount !== undefined
    ? sql`${chainEvents.amountRaw} >= ${p.minAmount}::numeric * (10::numeric ^ ${tokens.decimals})`
    : undefined;

  const filters: (SQL | undefined)[] = [
    scopeCond, periodCond, kindCond, cpCond, tokenCond, verifiedCond, minCond,
    chainFilter(p.chainIds),
  ];

  const cursorCond = p.cursor
    ? (() => {
        const c = decodeCursor(p.cursor!);
        return sql`(${chainEvents.chainId}, ${chainEvents.blockNumber}, ${chainEvents.logIndex}, ${chainEvents.id}) > (${c.chainId}, ${c.blockNumber}, ${c.logIndex}, ${c.id})`;
      })()
    : undefined;

  const rows = await db
    .select({
      chainId: chainEvents.chainId,
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      id: chainEvents.id,
      kind: chainEvents.eventKind,
      amountRaw: chainEvents.amountRaw,
      fromAddr: chainEvents.fromAddr,
      toAddr: chainEvents.toAddr,
      blockNumber: chainEvents.blockNumber,
      blockTime: chainEvents.blockTime,
      tokenId: tokens.id,
      tokenAddress: tokens.address,
      symbolDisplay: tokens.symbolDisplay,
      decimals: tokens.decimals,
      verified: tokens.verified,
      isStablecoin: tokens.isStablecoin,
      pegCurrency: tokens.pegCurrency,
    })
    .from(chainEvents)
    .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
    .where(and(...filters, cursorCond))
    .orderBy(chainEvents.chainId, chainEvents.blockNumber, chainEvents.logIndex, chainEvents.id)
    .limit(limit + 1);

  // `total_count` is a full COUNT(*) over the filter — costly on a deep drilldown.
  // Compute it only on the first page (no cursor); paginating callers cache it
  // (contracts §6.1) rather than re-scanning on every `nextCursor`.
  let totalCount: number | undefined;
  if (!p.cursor) {
    const counted = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(chainEvents)
      .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
      .where(and(...filters));
    totalCount = counted[0]?.n ?? 0;
  }

  const S = new Set(addresses);
  const page = rows.slice(0, limit);
  const events: EventListItem[] = page.map((r) => {
    const fromIn = S.has(r.fromAddr);
    const toIn = S.has(r.toAddr);
    return {
      chainId: r.chainId,
      txHash: r.txHash,
      logIndex: r.logIndex,
      id: r.id,
      kind: r.kind,
      blockNumber: r.blockNumber,
      blockTime: r.blockTime.toISOString(),
      token: {
        tokenId: r.tokenId,
        chainId: r.chainId,
        address: r.tokenAddress,
        symbolDisplay: r.symbolDisplay,
        decimals: r.decimals,
        verified: r.verified,
        isStablecoin: r.isStablecoin,
        pegCurrency: r.pegCurrency,
      },
      amountRaw: r.amountRaw.toString(),
      amount: formatUnits(r.amountRaw, r.decimals),
      fromAddr: r.fromAddr,
      toAddr: r.toAddr,
      direction: fromIn && toIn ? 'internal' : toIn ? 'in' : 'out',
    };
  });

  const result: ListEventsResult = { events };
  if (totalCount !== undefined) result.totalCount = totalCount;
  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    result.nextCursor = encodeCursor({ chainId: last.chainId, blockNumber: last.blockNumber, logIndex: last.logIndex, id: last.id });
  }
  return result;
}

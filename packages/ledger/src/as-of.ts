/**
 * Resolve an `as_of` date to the per-chain citable anchor echoed in
 * `as_of_effective` (contracts §6.1): the max block of *this wallet's own
 * activity* strictly before the start of the day after that UTC day — not the
 * ingestion head from checkpoints ("balance on May 31" is well-defined against
 * that anchor, half-open so a microsecond-precision block_time at the tail of
 * the day is not silently dropped, H10 minors). Block number and block time
 * are maxed independently (monotonic on real chains). Citation semantics are
 * unchanged: the caller still cites the requested `asOfDate`, not this cutoff.
 */
import { chainEvents, type Db } from '@reconcil/db';
import { and, inArray, lt, or, sql } from 'drizzle-orm';

import type { AsOfResolved } from './types.js';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function resolveAsOf(
  db: Db,
  opts: { addresses: string[]; chainIds?: number[]; cutoff?: Date; asOfDate?: string },
): Promise<AsOfResolved[]> {
  const { addresses, chainIds, cutoff, asOfDate } = opts;
  if (addresses.length === 0) return [];

  const rows = await db
    .select({
      chainId: chainEvents.chainId,
      block: sql<string | null>`max(${chainEvents.blockNumber})`,
      time: sql<string | Date | null>`max(${chainEvents.blockTime})`,
    })
    .from(chainEvents)
    .where(
      and(
        or(inArray(chainEvents.fromAddr, addresses), inArray(chainEvents.toAddr, addresses)),
        cutoff ? lt(chainEvents.blockTime, cutoff) : undefined,
        chainIds && chainIds.length > 0 ? inArray(chainEvents.chainId, chainIds) : undefined,
      ),
    )
    .groupBy(chainEvents.chainId);

  return rows
    .map((r) => ({
      chainId: r.chainId,
      block: r.block === null ? null : Number(r.block),
      date: asOfDate ?? (r.time === null ? isoDate(cutoff ?? new Date()) : isoDate(new Date(r.time))),
    }))
    .sort((a, b) => a.chainId - b.chainId);
}

/**
 * Resolve an `as_of` date to the per-chain citable anchor echoed in
 * `as_of_effective` (contracts §6.1): the max block of *this wallet's own
 * activity* whose time ≤ end of that UTC day — not the ingestion head from
 * checkpoints. "Balance on May 31" is well-defined against that anchor; block
 * number and block time are maxed independently (monotonic on real chains).
 */
import { chainEvents, type Db } from '@pet-crypto/db';
import { and, inArray, lte, or, sql } from 'drizzle-orm';

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
        cutoff ? lte(chainEvents.blockTime, cutoff) : undefined,
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

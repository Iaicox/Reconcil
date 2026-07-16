import type { Page, PageQuery } from './types.js';

/**
 * Drain all pages for a window. Fixture-capture pager: continues from
 * lastBlock + 1. NB: the production backfill (worker spec) overlaps at
 * lastBlock − 1 and relies on DB dedup instead — this helper is for capture
 * and golden replay, where the same deterministic URL sequence matters more
 * than block-split safety (03-ingestion §3).
 */
export async function collectAllPages<T extends { blockNumber: string }>(
  fetchPage: (q: PageQuery) => Promise<Page<T>>,
  q: PageQuery,
): Promise<T[]> {
  const all: T[] = [];
  let fromBlock = q.fromBlock;
  for (;;) {
    const page = await fetchPage({ ...q, fromBlock });
    all.push(...page.items);
    if (page.items.length < q.limit) return all;
    const last = page.items.at(-1);
    if (!last) return all;
    fromBlock = BigInt(last.blockNumber) + 1n;
  }
}

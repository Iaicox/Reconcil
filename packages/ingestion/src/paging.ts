import type { Page, PageQuery } from './types.js';

/**
 * Drain all pages for a window. Fixture-capture pager: continues from
 * lastBlock + 1. NB: the production backfill (worker spec) overlaps at
 * lastBlock − 1 and relies on DB dedup instead — this helper is for capture
 * and golden replay, where the same deterministic URL sequence matters more
 * than block-split safety (03-ingestion §3). A full page ending mid-block can
 * still drop that block's remaining rows; the guard below catches the certain
 * case (a whole page inside one block), the residual risk is accepted for
 * capture.
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
    const first = page.items[0];
    if (!last || !first) return all;
    if (first.blockNumber === last.blockNumber) {
      throw new Error(
        `page limit ${String(q.limit)} exhausted inside a single block (${last.blockNumber}) — advancing would silently drop rows; raise the limit`,
      );
    }
    fromBlock = BigInt(last.blockNumber) + 1n;
  }
}

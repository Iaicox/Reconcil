import { describe, expect, it } from 'vitest';
import { collectAllPages } from '../src/paging.js';
import type { Page, PageQuery } from '../src/types.js';

const Q: PageQuery = {
  chainId: 1,
  address: '0xabc',
  fromBlock: 0n,
  toBlock: 1000n,
  limit: 2,
  sort: 'asc',
};

function pager(pages: { blockNumber: string }[][]) {
  const queries: PageQuery[] = [];
  let i = 0;
  const fetchPage = (q: PageQuery): Promise<Page<{ blockNumber: string }>> => {
    queries.push(q);
    return Promise.resolve({ items: pages[i++] ?? [] });
  };
  return { fetchPage, queries };
}

describe('collectAllPages', () => {
  it('returns a short first page as-is', async () => {
    const { fetchPage, queries } = pager([[{ blockNumber: '5' }]]);
    const all = await collectAllPages(fetchPage, Q);
    expect(all).toHaveLength(1);
    expect(queries).toHaveLength(1);
  });

  it('continues from lastBlock+1 while pages are full', async () => {
    const { fetchPage, queries } = pager([
      [{ blockNumber: '1' }, { blockNumber: '2' }],
      [{ blockNumber: '3' }, { blockNumber: '4' }],
      [{ blockNumber: '9' }],
    ]);
    const all = await collectAllPages(fetchPage, Q);
    expect(all.map((r) => r.blockNumber)).toEqual(['1', '2', '3', '4', '9']);
    expect(queries.map((q) => q.fromBlock)).toEqual([0n, 3n, 5n]);
    expect(queries.every((q) => q.toBlock === 1000n)).toBe(true);
  });

  it('stops on an empty page', async () => {
    const { fetchPage } = pager([[{ blockNumber: '1' }, { blockNumber: '2' }], []]);
    const all = await collectAllPages(fetchPage, Q);
    expect(all).toHaveLength(2);
  });
});

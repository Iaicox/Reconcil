/**
 * One ingestion window for a (chain, address, stream), committed atomically
 * (03-ingestion §3). Never queries past safeHead = head − finalityDepth
 * (ADR-005). Full page ⇒ overlap the boundary block (cursor = last − 1) and stay
 * backfilling; short page ⇒ cursor = safeHead, status live. Receipts feed gas
 * (opstack), erc20 logIndex, and tx-level from/to (spec §6).
 */
import type { Logger } from '@pet-crypto/core';
import { chainById } from '@pet-crypto/core';
import type { Db } from '@pet-crypto/db';
import { assignErc20Metadata } from '../logindex.js';
import { normalize } from '../normalize.js';
import type { ProviderBundle } from '../providers/provider-factory.js';
import type { NormalizedEvent, PageQuery, RawReceipt } from '../types.js';
import { commitPage, getCheckpoint } from '../write/checkpoint-repo.js';

// ProcessorDeps lives here (the shared core) so backfill.ts/tail.ts import it
// from ingest.ts — no ingest ↔ backfill cycle (dependency-cruiser no-circular).
export interface ProcessorDeps { db: Db; bundleFor(chainId: number): ProviderBundle; logger: Logger; }
export interface IngestTarget { chainId: number; address: string; stream: 'native' | 'erc20'; }
export interface IngestResult { status: 'backfilling' | 'live'; lastProcessedBlock: number; inserted: number; unseenContracts: string[]; }

const PAGE_LIMIT = 1000;
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const byHash = (rs: RawReceipt[]): Map<string, RawReceipt> => new Map(rs.map((r) => [r.transactionHash, r]));

export async function ingestOnce(deps: ProcessorDeps, target: IngestTarget): Promise<IngestResult> {
  const chain = chainById(target.chainId);
  const bundle = deps.bundleFor(target.chainId);
  const cp = await getCheckpoint(deps.db, target.chainId, target.address, target.stream);
  if (!cp) throw new Error('no checkpoint for target');

  const head = await bundle.indexer.getHead(target.chainId);
  const safe = head - chain.finalityDepth;
  const fromBlock = BigInt(cp.lastProcessedBlock) + 1n;
  if (fromBlock > safe) {
    await commitPage(deps.db, target, [], { lastProcessedBlock: Number(safe), status: 'live' }, chain);
    return { status: 'live', lastProcessedBlock: Number(safe), inserted: 0, unseenContracts: [] };
  }

  const q: PageQuery = { chainId: target.chainId, address: target.address, fromBlock, toBlock: safe, limit: PAGE_LIMIT, sort: 'asc' };
  let events: NormalizedEvent[];
  let unseenContracts: string[] = [];
  let lastBlock: string | undefined;
  let itemCount: number;

  if (target.stream === 'native') {
    const page = await bundle.indexer.getNativeTxs(q);
    itemCount = page.items.length;
    lastBlock = page.items.at(-1)?.blockNumber;
    let receipts = new Map<string, RawReceipt>();
    if (chain.feeStrategy === 'receipts-opstack') {
      const outHashes = uniq(page.items.filter((t) => t.from.toLowerCase() === target.address).map((t) => t.hash.toLowerCase()));
      receipts = byHash(await bundle.getReceipts(outHashes));
    }
    events = normalize({ native: page }, {
      chainId: target.chainId, trackedAddress: target.address, feeStrategy: chain.feeStrategy,
      provider: bundle.indexer.kind, receipts,
    });
  } else {
    const page = await bundle.indexer.getErc20Transfers(q);
    itemCount = page.items.length;
    lastBlock = page.items.at(-1)?.blockNumber;
    const receipts = byHash(await bundle.getReceipts(uniq(page.items.map((t) => t.hash.toLowerCase()))));
    const enriched = assignErc20Metadata(page.items, receipts);
    events = normalize({ erc20: { items: enriched } }, {
      chainId: target.chainId, trackedAddress: target.address, feeStrategy: chain.feeStrategy, provider: bundle.indexer.kind,
    });
    // Every erc20 contract referenced in this page (deduped) — NOT filtered to
    // contracts unknown to `tokens`. The deferred token-resolve queue does that
    // filtering; here we just surface the candidates it will consume.
    unseenContracts = uniq(page.items.map((t) => t.contractAddress.toLowerCase()));
  }

  const full = itemCount >= PAGE_LIMIT;
  const newCursor = full && lastBlock !== undefined ? Number(BigInt(lastBlock) - 1n) : Number(safe);
  // Overlap-by-one pagination (cursor = last − 1) is block-granular: it cannot
  // split a single block. A full page whose cursor does not advance means one
  // block holds ≥ PAGE_LIMIT tracked-relevant items — re-fetching the same window
  // would loop forever, burning provider calls. Fail loudly instead (→ BullMQ
  // retry → DLQ, surfaced via the checkpoint status) rather than silently spin;
  // the eth_getLogs index-pagination that resolves this is deferred (03-ingestion
  // §11 Risks, ADR-005).
  if (full && newCursor <= cp.lastProcessedBlock) {
    throw new Error(
      `ingest stalled: a single block holds >= ${String(PAGE_LIMIT)} relevant ${target.stream} ` +
        `items (chain ${String(target.chainId)}, block ${lastBlock ?? '?'}); ` +
        `block-granular pagination cannot advance`,
    );
  }
  const status = full ? 'backfilling' : 'live';
  const inserted = await commitPage(deps.db, target, events, { lastProcessedBlock: newCursor, status }, chain);
  return { status, lastProcessedBlock: newCursor, inserted, unseenContracts };
}

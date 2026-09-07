/**
 * One ingestion window for a (chain, address, stream), committed atomically
 * (03-ingestion §3). Never queries past safeHead = head − finalityDepth
 * (ADR-005). Full page ⇒ overlap the boundary block (cursor = last − 1) and stay
 * backfilling; short page ⇒ cursor = safeHead, status live. Receipts feed gas
 * (opstack), erc20 logIndex, and tx-level from/to (spec §6).
 *
 * The `native` stream fetches TWO provider pages over the same window — txlist
 * and txlistinternal (ADR-005 d2, the R3 gap: contract-initiated ETH that txlist
 * simply does not report) — behind one checkpoint. Both feed `resolveCursor`,
 * which takes the minimum of their candidates, so the shared cursor never
 * advances past a block whose internal transfers were truncated.
 */
import type { Logger } from '@reconcil/core';
import { chainById } from '@reconcil/core';
import type { Db } from '@reconcil/db';
import { assignErc20Metadata } from '../logindex.js';
import { normalize } from '../normalize.js';
import type { ProviderBundle } from '../providers/provider-factory.js';
import type { NormalizedEvent, PageQuery, RawReceipt } from '../types.js';
import { commitPage, getCheckpoint, type CheckpointStatus } from '../write/checkpoint-repo.js';

// ProcessorDeps lives here (the shared core) so backfill.ts/tail.ts import it
// from ingest.ts — no ingest ↔ backfill cycle (dependency-cruiser no-circular).
export interface ProcessorDeps { db: Db; bundleFor(chainId: number): ProviderBundle; logger: Logger; }
export interface IngestTarget { chainId: number; address: string; stream: 'native' | 'erc20'; }
// `status` is the full stored-checkpoint status type, not just 'backfilling' | 'live':
// the H7 skip branch below reports whatever status is actually stored (queued, paused,
// error, anchoring included — reachable via a stray/duplicate job hitting a checkpoint
// ingestOnce wouldn't normally see), never a narrowed/coerced guess. Both call sites that
// branch on this value (apps/worker/src/main.ts, processors/tail.ts) only ever test
// `=== 'backfilling'`, so the widened union changes nothing for them.
export interface IngestResult { status: CheckpointStatus; lastProcessedBlock: number; inserted: number; unseenContracts: string[]; }

const PAGE_LIMIT = 1000;
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const byHash = (rs: RawReceipt[]): Map<string, RawReceipt> => new Map(rs.map((r) => [r.transactionHash, r]));

/** One provider page this run fetched, reduced to what the cursor depends on. */
interface FetchedPage {
  label: 'native' | 'internal' | 'erc20';
  itemCount: number;
  /** blockNumber of the last item, provider-sorted ascending; undefined on an empty page. */
  lastBlock: string | undefined;
}
const pageOf = (label: FetchedPage['label'], items: { blockNumber: string }[]): FetchedPage => ({
  label, itemCount: items.length, lastBlock: items.at(-1)?.blockNumber,
});

/**
 * Where the checkpoint may move given every page this stream fetched.
 *
 * Each page contributes a candidate: a FULL page means the window still holds
 * rows the provider truncated, so the cursor stops one block short of that
 * page's last block (overlap-by-one — the boundary block is re-fetched whole
 * next run and dedupes on the append-only key); a short page means the window
 * is exhausted, so the cursor may go all the way to safeHead.
 *
 * The stream's cursor is the MINIMUM of the candidates. With two pages behind
 * one checkpoint, taking anything larger would step past a block whose other
 * page was truncated — and nothing ever revisits a passed block (chain_events
 * is append-only, there is no reorg/backfill second pass). The cost is
 * re-fetching the non-truncated page's tail on the next run; ON CONFLICT DO
 * NOTHING makes that free of side effects, just of provider calls.
 */
function resolveCursor(
  pages: FetchedPage[], safe: bigint,
): { full: boolean; newCursor: number; stalled: FetchedPage[] } {
  const candidate = (p: FetchedPage): number =>
    p.itemCount >= PAGE_LIMIT && p.lastBlock !== undefined ? Number(BigInt(p.lastBlock) - 1n) : Number(safe);
  const newCursor = Math.min(...pages.map(candidate));
  return {
    full: pages.some((p) => p.itemCount >= PAGE_LIMIT),
    newCursor,
    // Whichever full page(s) pinned the cursor — named in the stall error below.
    stalled: pages.filter((p) => p.itemCount >= PAGE_LIMIT && candidate(p) === newCursor),
  };
}

export async function ingestOnce(deps: ProcessorDeps, target: IngestTarget): Promise<IngestResult> {
  const chain = chainById(target.chainId);
  const bundle = deps.bundleFor(target.chainId);
  const cp = await getCheckpoint(deps.db, target.chainId, target.address, target.stream);
  if (!cp) throw new Error('no checkpoint for target');

  const head = await bundle.indexer.getHead(target.chainId);
  const safe = head - chain.finalityDepth;
  const fromBlock = BigInt(cp.lastProcessedBlock) + 1n;
  if (fromBlock > safe) {
    const safeNum = Number(safe);
    // H7: a load-balanced provider node can return a slightly stale head (safe <
    // cursor), and on a fresh/dev chain head < finalityDepth makes safe negative.
    // Either way, committing here would regress or zero-out the cursor — "events
    // complete <= last_processed_block" would be violated. Skip the commit
    // entirely (nothing to insert on this path anyway) and report the checkpoint
    // exactly as stored — `cp.status` verbatim, no coercion — only a genuine
    // advance (safe > cursor) is legitimate.
    //
    // Known retry nuance: a freshly-seeded `queued` checkpoint hitting this path
    // (e.g. a fresh/dev chain, trigger (b)) is reported back as `queued`, not
    // promoted to `live`/`backfilling` — nothing here advances it. The onboard
    // scan's periodic re-scan of `queued` checkpoints will retry it (no new
    // mechanism needed), subject to BullMQ's completed-job dedup aging out for
    // its deterministic backfillJobId so the retry isn't a no-op re-add.
    if (safeNum <= cp.lastProcessedBlock) {
      deps.logger.warn('ingest: safe head at or below the cursor — skipping commit to avoid regressing it', {
        chainId: target.chainId, address: target.address, stream: target.stream,
        safe: safeNum, lastProcessedBlock: cp.lastProcessedBlock,
      });
      return {
        status: cp.status,
        lastProcessedBlock: cp.lastProcessedBlock,
        inserted: 0,
        unseenContracts: [],
      };
    }
    await commitPage(deps.db, target, [], { lastProcessedBlock: safeNum, status: 'live' }, chain);
    return { status: 'live', lastProcessedBlock: safeNum, inserted: 0, unseenContracts: [] };
  }

  const q: PageQuery = { chainId: target.chainId, address: target.address, fromBlock, toBlock: safe, limit: PAGE_LIMIT, sort: 'asc' };
  let events: NormalizedEvent[];
  let unseenContracts: string[] = [];
  let pages: FetchedPage[];

  if (target.stream === 'native') {
    const page = await bundle.indexer.getNativeTxs(q);
    // Trace-level ETH movements over the SAME window, on their own page budget
    // (ADR-005 d2). Optional capability: a chain whose providers serve no trace
    // data ingests txlist-only, exactly as before — the integrity job surfaces
    // the resulting drift rather than ingestion failing every page.
    const internal = bundle.indexer.getInternalTxs
      ? await bundle.indexer.getInternalTxs({ ...q })
      : undefined;
    // Receipts stay driven by the NATIVE page alone. Gas is a tx-level fee already
    // charged on the parent txlist row, so normalize() synthesizes no gas_fee for
    // an internal transfer and never looks a receipt up for one.
    let receipts = new Map<string, RawReceipt>();
    if (chain.feeStrategy === 'receipts-opstack') {
      const outHashes = uniq(page.items.filter((t) => t.from.toLowerCase() === target.address).map((t) => t.hash.toLowerCase()));
      receipts = byHash(await bundle.getReceipts(outHashes));
    }
    events = normalize({ native: page, internal }, {
      chainId: target.chainId, trackedAddress: target.address, feeStrategy: chain.feeStrategy,
      provider: bundle.indexer.kind, receipts,
    });
    pages = [pageOf('native', page.items), ...(internal ? [pageOf('internal', internal.items)] : [])];
  } else {
    const page = await bundle.indexer.getErc20Transfers(q);
    const receipts = byHash(await bundle.getReceipts(uniq(page.items.map((t) => t.hash.toLowerCase()))));
    const enriched = assignErc20Metadata(page.items, receipts);
    events = normalize({ erc20: { items: enriched } }, {
      chainId: target.chainId, trackedAddress: target.address, feeStrategy: chain.feeStrategy, provider: bundle.indexer.kind,
    });
    // Every erc20 contract referenced in this page (deduped) — NOT filtered to
    // contracts unknown to `tokens`. The deferred token-resolve queue does that
    // filtering; here we just surface the candidates it will consume.
    unseenContracts = uniq(page.items.map((t) => t.contractAddress.toLowerCase()));
    pages = [pageOf('erc20', page.items)];
  }

  const { full, newCursor, stalled } = resolveCursor(pages, safe);
  // Overlap-by-one pagination (cursor = last − 1) is block-granular: it cannot
  // split a single block. A full page whose cursor does not advance means one
  // block holds ≥ PAGE_LIMIT tracked-relevant items — re-fetching the same window
  // would loop forever, burning provider calls. Fail loudly instead (→ BullMQ
  // retry → DLQ, surfaced via the checkpoint status) rather than silently spin;
  // the eth_getLogs index-pagination that resolves this is deferred (03-ingestion
  // §11 Risks, ADR-005). Both native-stream pages are subject to this: a block
  // with ≥ PAGE_LIMIT internal transfers stalls the stream exactly as a block
  // with ≥ PAGE_LIMIT txlist rows does.
  if (full && newCursor <= cp.lastProcessedBlock) {
    const where = stalled.map((p) => `${p.label} @ block ${p.lastBlock ?? '?'}`).join(', ');
    throw new Error(
      `ingest stalled: a single block holds >= ${String(PAGE_LIMIT)} relevant ${target.stream} ` +
        `items (chain ${String(target.chainId)}, ${where}); ` +
        `block-granular pagination cannot advance`,
    );
  }
  const status = full ? 'backfilling' : 'live';
  // NEVER STORE PAST THE CURSOR. A page cut at PAGE_LIMIT can end in the middle of a
  // transaction, and `normalize` derives an internal transfer's sentinel from the
  // traces PRESENT IN THAT CALL: committing a truncated tx would store its traces
  // under ranks computed from a partial set, then the overlap re-fetch would see the
  // whole set, assign different ranks, and the two numberings would interleave —
  // ON CONFLICT dropping a real value movement while re-inserting another under a
  // fresh sentinel. Double-counted and lost money, silently.
  //
  // Withholding everything above `newCursor` closes that by construction: the next
  // window starts at newCursor + 1 and runs to `safe`, so every withheld row is
  // re-fetched — and re-fetched WHOLE, because the cursor is block-granular and can
  // never stop inside a block. It also makes the store's own invariant literal
  // ("events are complete for blocks ≤ last_processed_block") rather than merely
  // true-in-practice, and it costs nothing: the rows were going to be re-fetched by
  // the overlap anyway.
  //
  // Applied uniformly, not just to internal rows. Native/erc20 rows above the cursor
  // are individually safe to store (their sentinels are fixed, −1/−2/log index), but
  // a uniform rule is the one that stays correct when a future stream gains
  // set-derived keys, and re-fetching them is already the pagination contract.
  const cursorBlock = BigInt(newCursor);
  const committable = events.filter((e) => e.blockNumber <= cursorBlock);
  const inserted = await commitPage(deps.db, target, committable, { lastProcessedBlock: newCursor, status }, chain);
  return { status, lastProcessedBlock: newCursor, inserted, unseenContracts };
}

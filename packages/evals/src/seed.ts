/**
 * Golden-wallet fixture seeding (04-testing.md §2): replay the recorded provider
 * fixtures through the real ingestion pipeline (adapter → collectAllPages → normalize)
 * and persist native+gas events into a database the ledger can query. This composes
 * ingestion + ledger, which is why the harness lives in `packages/evals` (a sibling of
 * both), not in either.
 *
 * Native + internal for now. erc20 rows cannot reach chain_events without receipt-derived
 * logIndex (the network-gated receipts capture, §2 unblocker (a)); Base(8453) gas needs
 * OP-stack RPC receipts (unblocker (c)). Both are deferred. Chain 1 seeds txlist +
 * txlistinternal + gas, so the computed native balance reconciles *exactly* to the
 * recorded `eth_get_balance` (R3 closed — the internal inflows txlist omits are the gap,
 * §2 unblocker (b), ADR-005 d2). The blockscout adapter is used throughout because it
 * also serves the recorded `eth_get_balance` the reconciliation checks against.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chainById } from '@reconcil/core';
import { tokens, type Db } from '@reconcil/db';
import {
  blockscoutAdapter,
  collectAllPages,
  fixtureTransport,
  insertEventRows,
  normalize,
  readManifest,
  toChainEventRow,
  type ChainDataProvider,
  type PageQuery,
  type ProviderBundle,
  type WalletManifestEntry,
} from '@reconcil/ingestion';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'providers');

export interface SeededWallet {
  address: string;
  chainId: number;
  nativeTokenId: number;
  toBlock: bigint;
  /** native_transfer events from both streams (txlist + txlistinternal). */
  nativeTransfers: number;
  /** subset of nativeTransfers that came from txlistinternal (sentinel log_index ≤ −1000). */
  internalTransfers: number;
  gasFees: number;
}

function manifestEntry(role: string): WalletManifestEntry {
  const entry = readManifest(join(FIXTURES, 'manifest.json')).find((w) => w.role === role);
  if (!entry) throw new Error(`no manifest entry for golden wallet role "${role}"`);
  return entry;
}

/** Blockscout adapter backed by the recorded fixtures for one chain. */
function blockscoutFor(chainId: number): ChainDataProvider {
  return blockscoutAdapter({
    fetchJson: fixtureTransport(join(FIXTURES, 'blockscout', String(chainId))),
    baseUrl: chainId === 1 ? 'https://eth.blockscout.com/api' : 'https://base.blockscout.com/api',
    chainId,
  });
}

/**
 * Seed a golden wallet's native+gas events into `db` via the real pipeline and return
 * what the reconciliation itest needs. Precondition: a fresh database with exactly one
 * native token per chain — call once per (wallet, chain). Only txlist-fee chains are
 * supported (chain 1); receipts-opstack (Base) needs the deferred RPC-receipts capture.
 */
export async function seedGoldenWallet(db: Db, role: string, chainId = 1): Promise<SeededWallet> {
  const chain = chainById(chainId);
  if (chain.feeStrategy !== 'txlist') {
    throw new Error(`seedGoldenWallet is txlist-only; chain ${String(chainId)} needs RPC receipts (deferred)`);
  }
  const entry = manifestEntry(role);
  const window = entry.chains[String(chainId)];
  if (!window) throw new Error(`golden wallet "${role}" has no chain ${String(chainId)} in the manifest`);

  const provider = blockscoutFor(chainId);
  const q: PageQuery = {
    chainId,
    address: entry.address,
    fromBlock: BigInt(window.fromBlock),
    toBlock: BigInt(window.toBlock),
    limit: 1000,
    sort: 'asc',
  };
  const [native, internal] = await Promise.all([
    collectAllPages((pq) => provider.getNativeTxs(pq), q),
    // Optional capability (ADR-009) — every configured provider has it, but stay honest.
    provider.getInternalTxs
      ? collectAllPages((pq) => provider.getInternalTxs!(pq), q)
      : Promise.resolve([]),
  ]);
  const events = normalize(
    { native: { items: native }, internal: { items: internal } },
    { chainId, trackedAddress: entry.address, feeStrategy: 'txlist', provider: provider.kind },
  );

  const inserted = await db
    .insert(tokens)
    .values({ chainId, address: null, standard: 'native', decimals: 18, isStablecoin: false, verified: true, symbolDisplay: 'ETH' })
    .returning({ id: tokens.id });
  const nativeTokenId = inserted[0]?.id;
  if (nativeTokenId === undefined) throw new Error('failed to seed the native token row');

  await insertEventRows(db, events.map((e) => toChainEventRow(e, nativeTokenId)));

  return {
    address: entry.address,
    chainId,
    nativeTokenId,
    toBlock: BigInt(window.toBlock),
    nativeTransfers: events.filter((e) => e.eventKind === 'native_transfer').length,
    internalTransfers: events.filter((e) => e.eventKind === 'native_transfer' && e.logIndex <= -1000).length,
    gasFees: events.filter((e) => e.eventKind === 'gas_fee').length,
  };
}

/** A golden wallet wired up so the PRODUCTION processors can ingest it from fixtures. */
export interface GoldenIngestFixture {
  address: string;
  chainId: number;
  /** What `ProcessorDeps.bundleFor` must hand back for this wallet. */
  bundle: ProviderBundle;
  /** head − finalityDepth, pinned to the manifest window's last block. */
  safeBlock: bigint;
}

/**
 * The same recorded fixtures, but driven through `ingestOnce` (checkpoint → pages →
 * normalize → commitPage) instead of the seed harness's own replay loop — the R3
 * reconciliation over the code that actually runs in the worker.
 *
 * Two window adjustments make a URL-keyed fixture set replayable under a processor
 * that picks its own window, and neither changes what the provider answered:
 *  - `getHead` is pinned to `toBlock + finalityDepth`, so the processor's
 *    `safeHead = head − finalityDepth` lands exactly on the recorded `endblock`
 *    (and ADR-005's "never query past safeHead" still holds, by construction);
 *  - the query's `fromBlock` is rewritten to the manifest's `fromBlock` (0), because
 *    a fresh checkpoint starts the processor at block 1 while capture recorded
 *    `startblock=0`. Block 0 is genesis and holds no transactions, so [0, toBlock]
 *    and [1, toBlock] contain the same rows.
 */
export function goldenIngestFixture(role: string, chainId = 1): GoldenIngestFixture {
  const chain = chainById(chainId);
  const entry = manifestEntry(role);
  const window = entry.chains[String(chainId)];
  if (!window) throw new Error(`golden wallet "${role}" has no chain ${String(chainId)} in the manifest`);
  const provider = blockscoutFor(chainId);
  const recordedFrom = BigInt(window.fromBlock);
  const toBlock = BigInt(window.toBlock);
  const atRecordedWindow = (q: PageQuery): PageQuery => ({ ...q, fromBlock: recordedFrom });

  const indexer: ChainDataProvider = {
    kind: provider.kind,
    getHead: () => Promise.resolve(toBlock + BigInt(chain.finalityDepth)),
    getNativeTxs: (q) => provider.getNativeTxs(atRecordedWindow(q)),
    getInternalTxs: (q) => provider.getInternalTxs!(atRecordedWindow(q)),
    getErc20Transfers: (q) => provider.getErc20Transfers(atRecordedWindow(q)),
  };

  return {
    address: entry.address,
    chainId,
    safeBlock: toBlock,
    bundle: {
      indexer,
      // chain 1 is feeStrategy 'txlist' — gas comes off the txlist row, so the
      // processor never asks for a receipt here (the OP-stack capture is deferred).
      getReceipts: () => Promise.resolve([]),
      getBlockByTime: (unixSeconds) => provider.getBlockByTime!(chainId, unixSeconds),
      getNativeBalanceAt: async (address, block) => ({
        balance: await provider.getNativeBalanceAt!(chainId, address, block),
        provider: provider.kind,
      }),
      getErc20BalanceAt: async (address, token, block) => ({
        balance: await provider.getErc20BalanceAt!(chainId, address, token, block),
        provider: provider.kind,
      }),
      estimateTxCount: () => Promise.resolve(undefined),
    },
  };
}

/**
 * The recorded provider-attested native balance at a block — the independent anchor the
 * reconciliation spot-checks the txlist-derived balance against (04-testing.md §2, R3).
 */
export async function recordedNativeBalance(role: string, chainId: number, block: bigint): Promise<bigint> {
  const entry = manifestEntry(role);
  const provider = blockscoutFor(chainId);
  if (!provider.getNativeBalanceAt) throw new Error('blockscout adapter lacks getNativeBalanceAt');
  return provider.getNativeBalanceAt(chainId, entry.address, block);
}

/**
 * Golden-wallet fixture seeding (04-testing.md §2): replay the recorded provider
 * fixtures through the real ingestion pipeline (adapter → collectAllPages → normalize)
 * and persist native+gas events into a database the ledger can query. This composes
 * ingestion + ledger, which is why the harness lives in `packages/evals` (a sibling of
 * both), not in either.
 *
 * Native-only for now. erc20 rows cannot reach chain_events without receipt-derived
 * logIndex (the network-gated receipts capture, §2 unblocker (a)); Base(8453) gas needs
 * OP-stack RPC receipts (unblocker (c)). Both are deferred — so seeding is txlist-only
 * (chain 1) and reconciliation is native+gas. The blockscout adapter is used throughout
 * because it also serves the recorded `eth_get_balance` the reconciliation checks against.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chainById } from '@pet-crypto/core';
import { tokens, type Db } from '@pet-crypto/db';
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
  type WalletManifestEntry,
} from '@pet-crypto/ingestion';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'providers');

export interface SeededWallet {
  address: string;
  chainId: number;
  nativeTokenId: number;
  toBlock: bigint;
  nativeTransfers: number;
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
  const native = await collectAllPages((pq) => provider.getNativeTxs(pq), q);
  const events = normalize(
    { native: { items: native } },
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
    gasFees: events.filter((e) => e.eventKind === 'gas_fee').length,
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

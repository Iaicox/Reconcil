/**
 * Anchored-window baseline (ADR-008, 03-ingestion §3). Resolves the requested
 * `anchor_from` date to a real block (never inside the unsafe tip — ADR-005
 * finality), fetches provider-attested balances there, writes one
 * `opening_balance` per held token, and flips the checkpoint `anchoring →
 * backfilling` so the normal backfill continues forward from the anchor. Native
 * and erc20 are separate streams: the native stream anchors the native balance,
 * the erc20 stream the curated verified token set. All coverage over the result
 * carries `ANCHORED_BASELINE` (C5), wired on the read side already.
 */
import { chainById } from '@pet-crypto/core';
import { tokens, type Db } from '@pet-crypto/db';
import { and, eq, isNull } from 'drizzle-orm';

import type { ProviderBundle } from '../providers/provider-factory.js';
import { buildOpeningBalanceRows, type OpeningBalance } from '../write/anchor-writer.js';
import { commitAnchor, type AnchorTarget } from '../write/checkpoint-repo.js';
import type { ProcessorDeps } from './ingest.js';

export interface AnchorResult {
  anchorBlock: number;
  inserted: number;
}

export async function runAnchor(deps: ProcessorDeps, target: AnchorTarget): Promise<AnchorResult> {
  const chain = chainById(target.chainId);
  const bundle = deps.bundleFor(target.chainId);

  // anchor_from (a date) → the last block at or before its UTC start, clamped to
  // safeHead so a same-day anchor never lands in the reorg-unsafe tip (ADR-005).
  const anchorTs = Math.floor(Date.parse(`${target.anchorFrom}T00:00:00Z`) / 1000);
  if (Number.isNaN(anchorTs)) throw new Error(`invalid anchor_from: ${target.anchorFrom}`);
  const safe = (await bundle.indexer.getHead(target.chainId)) - chain.finalityDepth;
  const resolved = await bundle.getBlockByTime(anchorTs);
  const block = Number(resolved > safe ? safe : resolved);
  const blockTime = new Date(anchorTs * 1000);

  const balances =
    target.stream === 'native'
      ? await nativeBalances(deps.db, bundle, target.chainId, target.address, BigInt(block))
      : await erc20Balances(deps.db, bundle, target.address, target.chainId, BigInt(block));

  const rows = buildOpeningBalanceRows({ chainId: target.chainId, address: target.address, block, blockTime, balances });
  const inserted = await commitAnchor(deps.db, target, rows, block);
  return { anchorBlock: block, inserted };
}

async function nativeBalances(
  db: Db,
  bundle: ProviderBundle,
  chainId: number,
  address: string,
  block: bigint,
): Promise<OpeningBalance[]> {
  const { balance, provider } = await bundle.getNativeBalanceAt(address, block);
  if (balance <= 0n) return []; // no baseline needed for a zero balance
  return [{ tokenId: await ensureNativeTokenId(db, chainId), amountRaw: balance, provider }];
}

async function erc20Balances(
  db: Db,
  bundle: ProviderBundle,
  address: string,
  chainId: number,
  block: bigint,
): Promise<OpeningBalance[]> {
  // Anchor token set = curated verified tokens (03-ingestion §3). The full
  // provider token-balance listing ∪ curated union is a follow-up.
  const curated = await db
    .select({ id: tokens.id, address: tokens.address })
    .from(tokens)
    .where(and(eq(tokens.chainId, chainId), eq(tokens.standard, 'erc20'), eq(tokens.verified, true)));
  const out: OpeningBalance[] = [];
  for (const t of curated) {
    if (!t.address) continue;
    const { balance, provider } = await bundle.getErc20BalanceAt(address, t.address, block);
    if (balance > 0n) out.push({ tokenId: t.id, amountRaw: balance, provider });
  }
  return out;
}

/** The native pseudo-token (address NULL) — created lazily if no seed shipped it. */
async function ensureNativeTokenId(db: Db, chainId: number): Promise<number> {
  const chain = chainById(chainId);
  await db
    .insert(tokens)
    .values({
      chainId,
      address: null,
      standard: 'native',
      symbolRaw: chain.native.symbol,
      nameRaw: chain.native.symbol,
      decimals: chain.native.decimals,
      verified: false,
    })
    .onConflictDoNothing({ target: [tokens.chainId, tokens.address] });
  const [row] = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.chainId, chainId), isNull(tokens.address)))
    .limit(1);
  if (!row) throw new Error(`native token resolve failed for chain ${String(chainId)}`);
  return row.id;
}

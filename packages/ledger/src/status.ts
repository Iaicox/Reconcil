/**
 * Coverage & freshness per (wallet, chain) from `ingestion_checkpoints` — the
 * agent's "can I trust this" check backing the C5 warnings (COVERAGE_INCOMPLETE,
 * ANCHORED_BASELINE, DATA_STALE). Reads checkpoints, not chain height, so
 * `backfillProgress` is best-effort/omitted (a stored head is an ingestion change).
 */
import { ANCHOR_SUGGEST_TX_THRESHOLD } from '@reconcil/core';
import { chainEvents, ingestionCheckpoints, tokens, type Db } from '@reconcil/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { StatusParams, StreamStatus, WalletCoverage } from './types.js';

const DEFAULT_FRESHNESS_SEC = 3600;

export async function getLedgerStatus(db: Db, p: StatusParams): Promise<WalletCoverage[]> {
  const addresses = p.addresses.map((a) => a.toLowerCase());
  if (addresses.length === 0) return [];
  const thresholdMs = (p.freshnessThresholdSec ?? DEFAULT_FRESHNESS_SEC) * 1000;
  const now = Date.now();

  const checkpoints = await db
    .select()
    .from(ingestionCheckpoints)
    .where(
      and(
        inArray(ingestionCheckpoints.address, addresses),
        p.chainIds && p.chainIds.length > 0 ? inArray(ingestionCheckpoints.chainId, p.chainIds) : undefined,
      ),
    )
    // Deterministic fold order (chainId, address, stream) — without it the
    // first-wins `w.integrity` pick below depends on Postgres' unspecified row
    // order and can flip between runs. 'erc20' < 'native' lexically, so within
    // a (chainId, address) group the erc20 stream's own drift check wins when
    // both streams have one; native's is used only when erc20's is absent.
    .orderBy(ingestionCheckpoints.chainId, ingestionCheckpoints.address, ingestionCheckpoints.stream);

  // Last ingested block time per (chain, address, STREAM) — H9: the naive
  // (chain, address) grouping copied one wallet-wide max(block_time) onto every
  // stream, so a dead erc20 stream inherited a fresh native transfer's timestamp
  // (or vice versa) and the DATA_STALE signal it feeds was defeated.
  //
  // The one-rule bucketing (H9, replaces a per-kind mapping): every event's
  // stream is its OWN token's standard, joined once via chain_events.token_id →
  // tokens.id. This is correct for every event kind uniformly, not just the easy
  // ones — native_transfer/internal-transfer/gas_fee always carry the chain's
  // native pseudo-token (standard='native') so they bucket as 'native'; erc20_transfer
  // always carries a standard='erc20' token. `opening_balance` is the case a
  // per-kind eventKind→stream map gets wrong: anchoring writes it for EITHER
  // stream (anchor.ts: nativeBalances() for the native anchor, erc20Balances()
  // for the curated ERC20 set when the erc20 stream anchors — same eventKind
  // either way), so only the token it actually anchors — not its eventKind —
  // says which stream it belongs to. tokens.standard is exactly the 'native' |
  // 'erc20' union StreamStatus.stream/ingestion_checkpoints.stream already use,
  // so no separate stream-name mapping is needed at all.
  //
  // Two index-friendly grouped scans (from-side via _from_idx, to-side via
  // _to_idx), each joined to tokens once — one query per side, independent of
  // the wallet-set size, rather than a max() query per (chain, address, stream) key.
  const maxTime = sql<string | Date | null>`max(${chainEvents.blockTime})`;
  const chainSet = [...new Set(checkpoints.map((c) => c.chainId))];
  const [fromRows, toRows] = await Promise.all([
    db
      .select({ chainId: chainEvents.chainId, addr: chainEvents.fromAddr, stream: tokens.standard, t: maxTime })
      .from(chainEvents)
      .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
      .where(and(inArray(chainEvents.chainId, chainSet), inArray(chainEvents.fromAddr, addresses)))
      .groupBy(chainEvents.chainId, chainEvents.fromAddr, tokens.standard),
    db
      .select({ chainId: chainEvents.chainId, addr: chainEvents.toAddr, stream: tokens.standard, t: maxTime })
      .from(chainEvents)
      .innerJoin(tokens, eq(tokens.id, chainEvents.tokenId))
      .where(and(inArray(chainEvents.chainId, chainSet), inArray(chainEvents.toAddr, addresses)))
      .groupBy(chainEvents.chainId, chainEvents.toAddr, tokens.standard),
  ]);
  const lastTimeByKey = new Map<string, Date>();
  for (const r of [...fromRows, ...toRows]) {
    if (r.t === null) continue;
    const key = `${r.chainId}|${r.addr}|${r.stream}`;
    const t = new Date(r.t);
    const cur = lastTimeByKey.get(key);
    if (!cur || t > cur) lastTimeByKey.set(key, t);
  }

  const groups = new Map<string, WalletCoverage>();
  // >50k probe hint lives on the native stream row (per wallet); read it aside and
  // fold it into `estimate` once `anchored` is known for the whole wallet.
  const hintByKey = new Map<string, number>();
  for (const c of checkpoints) {
    const key = `${c.chainId}|${c.address}`;
    let w = groups.get(key);
    if (!w) { w = { address: c.address, chainId: c.chainId, anchored: false, streams: [] }; groups.set(key, w); }

    const s: StreamStatus = {
      stream: c.stream,
      status: c.status,
      lastProcessedBlock: c.lastProcessedBlock,
      stale: now - c.updatedAt.getTime() > thresholdMs,
    };
    if (c.anchorBlock !== null) { s.anchorBlock = c.anchorBlock; w.anchored = true; }
    if (c.lastError !== null) s.lastError = c.lastError;
    // Per-stream freshness (H9): keyed by this checkpoint's OWN stream, not the
    // wallet-wide key above — a stream with no events of its own gets none.
    const lt = lastTimeByKey.get(`${key}|${c.stream}`);
    if (lt) s.lastBlockTime = lt.toISOString();
    w.streams.push(s);

    if (c.stream === 'native' && c.txCountHint !== null) hintByKey.set(key, c.txCountHint);
    // First-wins fold over the ORDER BY (chainId, address, stream) above: the
    // erc20 stream's own drift check wins over native's when both are present.
    if (c.lastIntegrity !== null && w.integrity === undefined) w.integrity = c.lastIntegrity;
  }

  return [...groups.values()]
    .map((w) => {
      const hint = hintByKey.get(`${w.chainId}|${w.address}`);
      const estimate =
        hint !== undefined
          ? { txCountHint: hint, suggestsAnchored: hint > ANCHOR_SUGGEST_TX_THRESHOLD && !w.anchored }
          : undefined;
      return {
        ...w,
        streams: w.streams.sort((a, b) => a.stream.localeCompare(b.stream)),
        ...(estimate ? { estimate } : {}),
      };
    })
    .sort((a, b) => a.chainId - b.chainId || a.address.localeCompare(b.address));
}

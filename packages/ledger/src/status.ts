/**
 * Coverage & freshness per (wallet, chain) from `ingestion_checkpoints` — the
 * agent's "can I trust this" check backing the C5 warnings (COVERAGE_INCOMPLETE,
 * ANCHORED_BASELINE, DATA_STALE). Reads checkpoints, not chain height, so
 * `backfillProgress` is best-effort/omitted (a stored head is an ingestion change).
 */
import { chainEvents, ingestionCheckpoints, type Db } from '@pet-crypto/db';
import { and, inArray, sql } from 'drizzle-orm';

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
    );

  // Last ingested block time per (chain, address): max(block_time) over events
  // where the wallet is sender OR recipient, powering the "as of" timestamp.
  // Two index-friendly grouped scans (from-side via _from_idx, to-side via
  // _to_idx) merged by later time — one query per side, independent of the
  // wallet-set size, rather than a max() query per (chain, address) key.
  const maxTime = sql<string | Date | null>`max(${chainEvents.blockTime})`;
  const chainSet = [...new Set(checkpoints.map((c) => c.chainId))];
  const [fromRows, toRows] = await Promise.all([
    db
      .select({ chainId: chainEvents.chainId, addr: chainEvents.fromAddr, t: maxTime })
      .from(chainEvents)
      .where(and(inArray(chainEvents.chainId, chainSet), inArray(chainEvents.fromAddr, addresses)))
      .groupBy(chainEvents.chainId, chainEvents.fromAddr),
    db
      .select({ chainId: chainEvents.chainId, addr: chainEvents.toAddr, t: maxTime })
      .from(chainEvents)
      .where(and(inArray(chainEvents.chainId, chainSet), inArray(chainEvents.toAddr, addresses)))
      .groupBy(chainEvents.chainId, chainEvents.toAddr),
  ]);
  const lastTimeByKey = new Map<string, Date>();
  for (const r of [...fromRows, ...toRows]) {
    if (r.t === null) continue;
    const key = `${r.chainId}|${r.addr}`;
    const t = new Date(r.t);
    const cur = lastTimeByKey.get(key);
    if (!cur || t > cur) lastTimeByKey.set(key, t);
  }

  const groups = new Map<string, WalletCoverage>();
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
    const lt = lastTimeByKey.get(key);
    if (lt) s.lastBlockTime = lt.toISOString();
    w.streams.push(s);

    if (c.lastIntegrity !== null && w.integrity === undefined) w.integrity = c.lastIntegrity;
  }

  return [...groups.values()]
    .map((w) => ({ ...w, streams: w.streams.sort((a, b) => a.stream.localeCompare(b.stream)) }))
    .sort((a, b) => a.chainId - b.chainId || a.address.localeCompare(b.address));
}

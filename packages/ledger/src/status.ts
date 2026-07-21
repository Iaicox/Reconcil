/**
 * Coverage & freshness per (wallet, chain) from `ingestion_checkpoints` — the
 * agent's "can I trust this" check backing the C5 warnings (COVERAGE_INCOMPLETE,
 * ANCHORED_BASELINE, DATA_STALE). Reads checkpoints, not chain height, so
 * `backfillProgress` is best-effort/omitted (a stored head is an ingestion change).
 */
import { chainEvents, ingestionCheckpoints, type Db } from '@pet-crypto/db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';

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

  // Last ingested block time per (chain, address) — one small query per key
  // (N wallets × chains is tiny); powers the "as of" timestamp in status.
  const lastTimeByKey = new Map<string, Date>();
  const keys = new Map<string, { chainId: number; address: string }>();
  for (const c of checkpoints) keys.set(`${c.chainId}|${c.address}`, { chainId: c.chainId, address: c.address });
  for (const [key, { chainId, address }] of keys) {
    const [row] = await db
      .select({ t: sql<Date | null>`max(${chainEvents.blockTime})` })
      .from(chainEvents)
      .where(and(eq(chainEvents.chainId, chainId), or(eq(chainEvents.fromAddr, address), eq(chainEvents.toAddr, address))));
    if (row?.t) lastTimeByKey.set(key, new Date(row.t));
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

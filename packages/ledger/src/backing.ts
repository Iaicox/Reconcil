/**
 * Backing-event refs for citations (C1/C3). A single event may back several
 * buckets — an internal transfer backs both wallets' balances — so the caller
 * supplies the bucket keys per event. Inline refs are capped at EVENT_REF_CAP
 * while the exact total is always counted (drilldown covers the rest).
 */
import { EVENT_REF_CAP, type BackingEvents, type EventRef } from './types.js';

export interface RefRow {
  chainId: number;
  txHash: string;
  logIndex: number;
}

export const emptyBacking = (): BackingEvents => ({ refs: [], totalCount: 0, capped: false });

export function bucketBacking<E extends RefRow>(
  events: E[],
  keysOf: (e: E) => string[],
): Map<string, BackingEvents> {
  const out = new Map<string, BackingEvents>();
  for (const e of events) {
    const ref: EventRef = { chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex };
    for (const k of keysOf(e)) {
      let b = out.get(k);
      if (!b) { b = emptyBacking(); out.set(k, b); }
      b.totalCount += 1;
      if (b.refs.length < EVENT_REF_CAP) b.refs.push(ref);
      else b.capped = true;
    }
  }
  return out;
}

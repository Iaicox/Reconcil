/**
 * Citation event-ref plumbing (C3). Collect the backing refs across an aggregate's
 * rows, dedupe them, and pick either inline `event_refs` (≤ REF_CAP) or an
 * `event_ref_summary` whose `drilldown` is an executable `analytics_list_events`
 * call enumerating the full backing set. Shared by every aggregate tool.
 */
import type { EnvelopeParts } from './envelope.js';

export const REF_CAP = 64;

export interface WireEventRef { chain_id: number; tx_hash: string; log_index: number }

/** The ledger backing shape (`refs` in ledger's camelCase EventRef + exact total). */
interface LedgerBacking { refs: { chainId: number; txHash: string; logIndex: number }[]; totalCount: number }

type Drilldown = { tool: 'analytics_list_events'; args: Record<string, unknown> };

export function dedupeRefs(refs: WireEventRef[]): WireEventRef[] {
  const seen = new Set<string>();
  const out: WireEventRef[] = [];
  for (const r of refs) {
    const k = `${String(r.chain_id)}|${r.tx_hash}|${String(r.log_index)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Inline refs when the total fits under the cap, else a summary + drilldown. */
export function selectRefs(
  backings: LedgerBacking[],
  drilldown: Drilldown,
): Pick<EnvelopeParts, 'eventRefs' | 'eventRefSummary'> {
  const allRefs: WireEventRef[] = [];
  let totalCount = 0;
  for (const b of backings) {
    totalCount += b.totalCount;
    for (const e of b.refs) allRefs.push({ chain_id: e.chainId, tx_hash: e.txHash, log_index: e.logIndex });
  }
  const deduped = dedupeRefs(allRefs);
  return totalCount <= REF_CAP && deduped.length <= REF_CAP
    ? { eventRefs: deduped }
    : { eventRefSummary: { count: totalCount, sample: deduped.slice(0, 10), drilldown } };
}

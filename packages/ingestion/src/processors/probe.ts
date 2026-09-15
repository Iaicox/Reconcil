/**
 * The >50k probe (ADR-008 Q5). A cheap, best-effort provider read of a wallet's
 * account NONCE — outbound transactions only, not its history size (ADR-008 d4) —
 * persisted on its native checkpoint. `ledger_status` reads it to surface
 * `suggests_anchored`; re-tracking in anchored mode is a separate explicit call, so
 * the probe never degrades coverage on its own.
 * Degrades silently when no provider can serve the estimate (e.g. Base free tier).
 */
import { setTxCountHint } from '../write/checkpoint-repo.js';
import type { ProcessorDeps } from './ingest.js';

export interface ProbeTarget {
  chainId: number;
  address: string;
}

export async function runProbe(deps: ProcessorDeps, target: ProbeTarget): Promise<number | undefined> {
  const hint = await deps.bundleFor(target.chainId).estimateTxCount(target.address);
  if (hint !== undefined) await setTxCountHint(deps.db, target.chainId, target.address, hint);
  return hint;
}

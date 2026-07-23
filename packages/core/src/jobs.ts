/**
 * Deterministic ingestion job ids. The backfill job id is the seam between the
 * onboarding write tool (`ledger_track_wallet`, which reports it to the caller)
 * and the worker scanner (which enqueues it): BullMQ dedups by job id, so both
 * sides MUST derive it identically — hence one shared definition here. Pure
 * string derivation, no I/O (shared-kernel rule, 00-overview §3).
 */
export function backfillJobId(chainId: number, address: string, stream: 'native' | 'erc20'): string {
  return `backfill:${String(chainId)}:${address.toLowerCase()}:${stream}`;
}

/** Anchor job (ADR-008): one per (chain, address, stream) awaiting its baseline. */
export function anchorJobId(chainId: number, address: string, stream: 'native' | 'erc20'): string {
  return `anchor:${String(chainId)}:${address.toLowerCase()}:${stream}`;
}

/** >50k probe job (ADR-008 Q5): one per (chain, address) — tx count is per wallet. */
export function probeJobId(chainId: number, address: string): string {
  return `probe:${String(chainId)}:${address.toLowerCase()}`;
}

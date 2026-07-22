/**
 * Map ledger coverage (per wallet/stream freshness) to the wire `CoverageRef[]`
 * and the C5 warnings every analytics_* tool must surface: COVERAGE_INCOMPLETE
 * (a stream still backfilling/errored), ANCHORED_BASELINE (figures rest on an
 * opening_balance anchor), DATA_STALE (a checkpoint past the freshness threshold).
 */
import type { CoverageRef, Warning } from '@pet-crypto/core';
import type { WalletCoverage } from '@pet-crypto/ledger';

export function mapCoverage(cov: WalletCoverage[]): { coverageRefs: CoverageRef[]; coverageWarnings: Warning[] } {
  const refs: CoverageRef[] = [];
  let incomplete = false;
  let anchored = false;
  let stale = false;
  for (const w of cov) {
    const status: CoverageRef['status'] = w.streams.some((s) => s.status === 'error')
      ? 'error'
      : w.streams.some((s) => s.status === 'backfilling')
        ? 'backfilling'
        : w.streams.some((s) => s.status === 'paused')
          ? 'paused'
          : 'live';
    const anchorBlock = w.streams.map((s) => s.anchorBlock).find((b) => b !== undefined);
    refs.push({
      chain_id: w.chainId,
      address: w.address,
      streams: w.streams.map((s) => s.stream),
      from_block: null,
      to_block: Math.max(0, ...w.streams.map((s) => s.lastProcessedBlock)),
      ...(anchorBlock !== undefined ? { anchor_block: anchorBlock } : {}),
      status,
    });
    if (w.streams.some((s) => s.status !== 'live')) incomplete = true;
    if (w.anchored) anchored = true;
    if (w.streams.some((s) => s.stale)) stale = true;
  }
  const coverageWarnings: Warning[] = [];
  if (incomplete) coverageWarnings.push({ code: 'COVERAGE_INCOMPLETE', message: 'a wallet/stream in scope is still backfilling or errored' });
  if (anchored) coverageWarnings.push({ code: 'ANCHORED_BASELINE', message: 'balances rest on an opening_balance anchor, not full history' });
  if (stale) coverageWarnings.push({ code: 'DATA_STALE', message: 'a checkpoint in scope is older than the freshness threshold' });
  return { coverageRefs: refs, coverageWarnings };
}

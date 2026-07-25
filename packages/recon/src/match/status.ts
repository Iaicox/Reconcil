/**
 * Record status as a pure function of confirmed legs (ADR-010 decision 2, invariant
 * enforced in the repo, not a DB trigger). Only the four derivable states are
 * returned here; `void` is a manual, terminal state set by a human, never derived.
 * Consumed at confirmation time (recon_confirm_match); shipped now because it is
 * pure engine logic and hermetically testable.
 */
import { computeBand, toMinor } from './score.js';
import type { Tolerances } from './types.js';

export type DerivedRecordStatus = 'open' | 'partially_matched' | 'matched' | 'overpaid';

/**
 * Derive status from the record's full `amount` and the summed fiat value of its
 * confirmed legs (`appliedFiat`), both decimal strings in the record's currency.
 * "matched" holds when the applied total lands within the same tolerance band the
 * engine matched on, so a within-tolerance settlement is not read as a partial.
 */
export function deriveRecordStatus(
  amount: string,
  appliedFiat: string,
  tolerances: Tolerances = {},
): DerivedRecordStatus {
  const applied = toMinor(appliedFiat);
  if (applied === 0n) return 'open';
  const band = computeBand(amount, tolerances); // band around the full amount
  const diff = applied - band.openMinor;
  const mag = diff < 0n ? -diff : diff;
  if (mag <= band.bandMinor) return 'matched';
  return applied < band.openMinor ? 'partially_matched' : 'overpaid';
}

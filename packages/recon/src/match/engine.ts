/**
 * The matching engine (ADR-010). Pure and deterministic: given a record and a set
 * of candidate settlement events already valued in the record's currency, it emits
 * scored legs. It never reads the DB, never calls a model, never values events —
 * the caller supplies `valuedAmount` (P1, package purity).
 *
 * A leg is emitted — and counted toward `anyFullMatch` — only when its scored
 * confidence is `> 0` (H18): `scoreCandidate` records a rule in the rationale only
 * when that rule actually contributed, so a positive confidence is always backed by
 * a non-empty rationale — no number without provenance (C1). A candidate landing
 * exactly on the tolerance-band edge with no other signal (amount score 0 at the
 * edge, no address/history/date hit) is therefore dropped silently, not suggested
 * at zero confidence with an empty rationale.
 *
 * A record with nothing outstanding (`openAmount <= 0`) is skipped before any
 * candidate is even scored (A4/A5) — nothing is owed, so no candidate can be "the"
 * payment for it.
 *
 * Split/partial payments are found by a bounded subset search: the pool is the
 * ≤ 6 LARGEST-valued candidate events in the date window (largest first, so a full
 * settlement needs the fewest legs), and the search then tries every subset within
 * that pool (the documented complexity cap, ADR-010 alt "unbounded subset-sum").
 * Two distinct cases therefore stay open, honestly: a record that would need more
 * than 6 events to settle at all, and — less obviously — one whose only exact split
 * includes a member too small to make the top-6-by-size pool even though fewer than
 * 6 events would suffice. Both are documented, visible failure modes, never hidden.
 */
import {
  DEFAULT_DATE_WINDOW_DAYS,
  computeBand,
  dayNumber,
  referenceDay,
  scoreCandidate,
  toMinor,
  withinBand,
  type Band,
} from './score.js';
import type { CandidateEvent, MatchRecord, SuggestedLeg, Tolerances } from './types.js';

/** ADR-010: bounded subset search considers at most this many candidate events per record. */
export const MAX_SUBSET_EVENTS = 6;

function isCandidate(record: MatchRecord, event: CandidateEvent, band: Band): boolean {
  if (withinBand(toMinor(event.valuedAmount), band)) return true; // amount alone qualifies
  if (record.expectedAddress !== null && event.counterpartyAddr === record.expectedAddress) return true;
  return record.knownCounterpartyAddresses.includes(event.counterpartyAddr);
}

/** Best summing subset (size ≥ 2) whose valued total lands within the band; null if none. */
function findBestSubset(
  record: MatchRecord,
  windowed: CandidateEvent[],
  band: Band,
  refDay: number | null,
  windowDays: number,
): CandidateEvent[] | null {
  // A member larger than open+band can only overshoot (amounts are non-negative), so drop it.
  const ceil = band.openMinor + band.bandMinor;
  const pool = windowed
    .filter((e) => toMinor(e.valuedAmount) <= ceil)
    .sort((a, b) => {
      const av = toMinor(a.valuedAmount);
      const bv = toMinor(b.valuedAmount);
      // Largest valued first — reach the sum with fewer legs; eventId breaks ties so the
      // pool (and thus the chosen subset) is deterministic regardless of input row order.
      return av < bv ? 1 : av > bv ? -1 : a.eventId - b.eventId;
    })
    .slice(0, MAX_SUBSET_EVENTS);

  const n = pool.length;
  let best: { events: CandidateEvent[]; confidence: number } | null = null;
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const chosen: CandidateEvent[] = [];
    let sum = 0n;
    for (let i = 0; i < n; i += 1) {
      if ((mask & (1 << i)) !== 0) {
        chosen.push(pool[i]!);
        sum += toMinor(pool[i]!.valuedAmount);
      }
    }
    if (chosen.length < 2) continue; // singles are handled in the single-event pass
    if (!withinBand(sum, band)) continue;
    const { confidence } = scoreCandidate({ record, events: chosen, band, refDay, windowDays });
    const better = best === null
      || chosen.length < best.events.length
      || (chosen.length === best.events.length && confidence > best.confidence);
    if (better) best = { events: chosen, confidence };
  }
  return best?.events ?? null;
}

/**
 * Suggest legs for one record. Single-event candidates first (full match within
 * tolerance, or a partial/overpayment from a known/expected sender); if none fully
 * settles the record, a bounded subset search proposes a split. Legs are deduped
 * per event (highest confidence wins) and returned most-confident first.
 */
export function suggestForRecord(
  record: MatchRecord,
  candidates: CandidateEvent[],
  tolerances: Tolerances = {},
): SuggestedLeg[] {
  const refDay = referenceDay(record);
  const windowDays = tolerances.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;
  const band = computeBand(record.openAmount, tolerances);

  // Nothing is outstanding: no candidate can be "the" payment for this record (A4/A5) —
  // return before filtering, scoring, or valuing anything against it.
  if (band.openMinor <= 0n) return [];

  // Drop non-positive amounts (a 0-value spam/approval transfer would otherwise pass the
  // address gate and produce a leg that violates the DB's amount_applied_raw > 0 check,
  // aborting the whole batch) and events outside the date window.
  const windowed = candidates.filter((e) =>
    e.amountRaw > 0n
    && (refDay === null || Math.abs(dayNumber(e.blockTime) - refDay) <= windowDays));

  const legs: SuggestedLeg[] = [];
  let anyFullMatch = false;
  for (const event of windowed) {
    if (!isCandidate(record, event, band)) continue;
    const { confidence, rationale } = scoreCandidate({ record, events: [event], band, refDay, windowDays });
    // No articulable reason (H18): the edge of the band alone scores 0, and with no
    // other rule firing there is nothing to cite — emit no leg, not one with an empty
    // rationale. `anyFullMatch` therefore only reflects candidates actually suggested.
    if (confidence <= 0) continue;
    if (withinBand(toMinor(event.valuedAmount), band)) anyFullMatch = true;
    legs.push({ eventId: event.eventId, amountAppliedRaw: event.amountRaw, fiatValue: event.valuedAmount, confidence, rationale });
  }

  if (!anyFullMatch) {
    const subset = findBestSubset(record, windowed, band, refDay, windowDays);
    if (subset !== null) {
      const { confidence, rationale } = scoreCandidate({ record, events: subset, band, refDay, windowDays });
      if (confidence > 0) { // same H18 guard as the single-event path
        for (const event of subset) {
          legs.push({ eventId: event.eventId, amountAppliedRaw: event.amountRaw, fiatValue: event.valuedAmount, confidence, rationale });
        }
      }
    }
  }

  // Dedupe per event (a subset member may also be a single-event address hit): keep the
  // higher-confidence leg. Return most-confident first, ties broken by event id (stable).
  const byEvent = new Map<number, SuggestedLeg>();
  for (const leg of legs) {
    const prev = byEvent.get(leg.eventId);
    if (prev === undefined || leg.confidence > prev.confidence) byEvent.set(leg.eventId, leg);
  }
  return [...byEvent.values()].sort((a, b) => b.confidence - a.confidence || a.eventId - b.eventId);
}

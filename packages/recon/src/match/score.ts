/**
 * Deterministic confidence scoring (ADR-010 decision 3). Four rules — amount,
 * address, date, counterparty history — each produce a score in [0,1]; the
 * confidence is Σ weightᵢ · scoreᵢ, and every fired rule is recorded in the
 * `rationale` (its `weight` = its contribution), so confidence is reproducible
 * from the rationale alone (P1: the engine scores, never the LLM). Weights are
 * tuning constants, gathered here as the single knob to turn.
 *
 * Amount comparison runs in integer minor units at a fixed scale (COMPARE_SCALE),
 * so no float ever touches a monetary value (ADR-004); the score ratios derived
 * from those integers are not money and may be `number`.
 */
import { parseUnits } from '@reconcil/core';

import type { CandidateEvent, MatchRecord, RuleHit, Tolerances } from './types.js';

/** Rule weights (max contribution each). Sum ≤ 1 so confidence stays in [0,1]. */
export const WEIGHTS = {
  amount: 0.35,
  address: 0.35,
  date: 0.2,
  history: 0.1,
} as const;

export const DEFAULT_AMOUNT_PCT = 1.0;
export const DEFAULT_DATE_WINDOW_DAYS = 14;

/** Fixed comparison scale: covers any token decimals (≤36 by the tokens CHECK) and fiat. */
const COMPARE_SCALE = 36;

const MS_PER_DAY = 86_400_000;

/** Decimal string → integer minor units at COMPARE_SCALE. Safe for ≤36 fractional digits. */
export function toMinor(value: string): bigint {
  return parseUnits(value, COMPARE_SCALE);
}

export interface Band {
  openMinor: bigint;
  bandMinor: bigint;
}

/**
 * Tolerance band around the open amount, in minor units: pct·open + abs. `pct` is
 * resolved to 4 decimal places (e4): `Math.round(pct * 10_000)` scaled units over a
 * `1_000_000n` divisor (A6) — e.g. `0.004` (%) yields a real 40e-6-of-open band; the
 * old e2 rounding (`pct * 100`) collapsed anything under 0.01% straight to 0. Precision
 * finer than e4 still rounds — a documented contract, never an error.
 */
export function computeBand(openAmount: string, tol: Tolerances): Band {
  const openMinor = toMinor(openAmount);
  const abs = tol.amountAbs ?? '0';
  const absMinor = toMinor(abs);
  const pct = tol.amountPct ?? DEFAULT_AMOUNT_PCT;
  // pct% → e4 fixed-point on the tolerance knob (not money); band math stays in bigint.
  const scaledPct = BigInt(Math.round(pct * 10_000));
  const pctMinor = (openMinor * scaledPct) / 1_000_000n;
  return { openMinor, bandMinor: pctMinor + absMinor };
}

const absBig = (x: bigint): bigint => (x < 0n ? -x : x);

/** True when a valued total lands inside the tolerance band of the open amount. */
export function withinBand(totalMinor: bigint, band: Band): boolean {
  return absBig(totalMinor - band.openMinor) <= band.bandMinor;
}

/** UTC day index of an ISO date/datetime string. */
export function dayNumber(iso: string): number {
  return Math.floor(Date.parse(iso) / MS_PER_DAY);
}

/** Amount score: 1 at an exact match, decaying linearly to 0 one band-width away, 0 beyond. */
function amountScore(totalMinor: bigint, band: Band): number {
  const diff = absBig(totalMinor - band.openMinor);
  if (band.bandMinor === 0n) return diff === 0n ? 1 : 0;
  if (diff >= band.bandMinor) return 0;
  return 1 - Number(diff) / Number(band.bandMinor);
}

/** Date score for a day delta: 1 the same day, decaying linearly to 0 at the window edge. */
function dateScoreFromDelta(delta: number, windowDays: number): number {
  if (windowDays <= 0) return delta === 0 ? 1 : 0;
  if (delta > windowDays) return 0;
  return 1 - delta / windowDays;
}

/** The reference date a record's payment is timed against. */
export function referenceDay(record: MatchRecord): number | null {
  const ref = record.dueOn ?? record.issuedOn;
  return ref === null ? null : dayNumber(ref);
}

export interface ScoreInput {
  record: MatchRecord;
  events: CandidateEvent[]; // one for a single-event leg, several for a subset
  band: Band;
  refDay: number | null;
  windowDays: number;
}

export interface Scored {
  confidence: number;
  rationale: RuleHit[];
}

/**
 * Score a candidate (single event or subset) across all four rules. Confidence is
 * the sum of fired-rule contributions; only fired rules (contribution > 0) enter
 * the rationale, so `Σ rationale.weight === confidence` EXACTLY by construction —
 * including under the rare rescale below (A3), not merely approximately.
 */
export function scoreCandidate(input: ScoreInput): Scored {
  const { record, events, band, refDay, windowDays } = input;
  const totalMinor = events.reduce((acc, e) => acc + toMinor(e.valuedAmount), 0n);

  const rationale: RuleHit[] = [];
  const fire = (rule: keyof typeof WEIGHTS, score: number, detail: string): void => {
    if (score <= 0) return;
    rationale.push({ rule, weight: WEIGHTS[rule] * score, detail });
  };

  const aScore = amountScore(totalMinor, band);
  const totalValued = events.map((e) => e.valuedAmount).join(' + ');
  fire('amount', aScore, `valued ${totalValued} vs open ${record.openAmount} ${record.currency}`);

  const expected = record.expectedAddress;
  const addressHit = expected !== null && events.some((e) => e.counterpartyAddr === expected);
  fire('address', addressHit ? 1 : 0, addressHit ? `counterparty matches expected ${String(expected)}` : '');

  const known = new Set(record.knownCounterpartyAddresses);
  const historyHit = events.some((e) => known.has(e.counterpartyAddr));
  fire('history', historyHit ? 1 : 0, historyHit ? 'counterparty seen for this record before' : '');

  // Worst (largest) day delta across the subset drives the date score.
  if (refDay !== null) {
    const maxDelta = Math.max(...events.map((e) => Math.abs(dayNumber(e.blockTime) - refDay)));
    fire('date', dateScoreFromDelta(maxDelta, windowDays), `within ${String(maxDelta)}d of the reference date`);
  }

  // The weights sum to exactly 1 and every score is ≤ 1, so this sum is near-unreachable
  // above 1 — but float summation of the fired contributions could in principle land a
  // hair over and trip the DB CHECK (confidence 0..1). A bare `Math.min(1, sum)` clamp
  // would break `Σ rationale.weight === confidence` exactly when it fires (A3): the
  // shipped rationale would no longer reproduce the shipped confidence. Instead, rescale
  // every shipped weight by the same factor and recompute confidence FROM the rescaled
  // rationale (not derived independently), so the invariant holds by construction even
  // here. Weights stay non-negative — the rescale factor is always positive.
  const rawSum = rationale.reduce((acc, r) => acc + r.weight, 0);
  if (rawSum <= 1) return { confidence: rawSum, rationale };
  const factor = 1 / rawSum;
  const rescaled = rationale.map((r) => ({ ...r, weight: r.weight * factor }));
  const confidence = rescaled.reduce((acc, r) => acc + r.weight, 0);
  return { confidence, rationale: rescaled };
}

/**
 * Matching-engine domain types (ADR-010). The engine is pure: it takes a record
 * plus already-valued candidate settlement events and returns scored legs — no
 * I/O, no DB, no pricing (the caller values events into the record's currency and
 * persists the result). Money crosses as decimal strings / base-unit `bigint`,
 * never `number` (ADR-004); confidence is a score in [0,1], not money.
 */

/** Match tolerances (contract §6.4). Defaults applied by the engine when omitted. */
export interface Tolerances {
  /** Amount band as a percent of the record's open amount. Default 1.0 (%). */
  amountPct?: number;
  /** Absolute amount band in the record's currency (decimal string). Added to the pct band. */
  amountAbs?: string;
  /** Half-width of the date window in days around the record's reference date. Default 14. */
  dateWindowDays?: number;
}

/** A record to reconcile (an invoice for now; `kind` is source-agnostic, ADR-010). */
export interface MatchRecord {
  id: string;
  /** Full gross amount, decimal string in `currency`. */
  amount: string;
  /** Amount still open = `amount` − Σ confirmed applied fiat; equals `amount` when none. */
  openAmount: string;
  currency: string;
  /** ISO date (YYYY-MM-DD) or null. */
  issuedOn: string | null;
  /** ISO date (YYYY-MM-DD) or null. The reference date is `dueOn ?? issuedOn`. */
  dueOn: string | null;
  /** Lowercased 0x-address the payment was expected from, or null. */
  expectedAddress: string | null;
  /** Lowercased addresses already known for this counterparty (address book / prior matches). */
  knownCounterpartyAddresses: string[];
}

/** A settlement event already valued in the record's currency by the caller. */
export interface CandidateEvent {
  eventId: number;
  /** Token base units (uint256) applied if this event is picked. */
  amountRaw: bigint;
  tokenDecimals: number;
  /** The event amount valued in the record's currency, decimal string (face value for stablecoins). */
  valuedAmount: string;
  /** ISO 8601 UTC datetime. */
  blockTime: string;
  /** Lowercased sender address. */
  fromAddr: string;
}

/** One rule's contribution to a suggestion's confidence (contract §6.4 rationale entry). */
export interface RuleHit {
  rule: string;
  /** The rule's contribution to confidence (weightᵢ · scoreᵢ); Σ rule weights = confidence. */
  weight: number;
  detail: string;
}

/** One suggested leg: this event applies to the record with a confidence + rationale. */
export interface SuggestedLeg {
  eventId: number;
  /** Portion of the event applied (whole event in this slice), token base units. */
  amountAppliedRaw: bigint;
  /** Valuation of the applied portion in the record's currency, decimal string. */
  fiatValue: string;
  /** Deterministic score in [0,1] = Σ of `rationale` weights. */
  confidence: number;
  rationale: RuleHit[];
}

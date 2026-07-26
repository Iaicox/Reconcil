/**
 * Reconciliation: `external_record ↔ settlement` matching with m:n legs and
 * deterministic scoring; an invoice is just one `kind` of external record
 * (ADR-010). Matches are confirmed by a human before they reach exports.
 *
 * Face B slice 1 ships the invoice importer; slice 2 adds the pure matching
 * engine and status derivation (the HITL confirm/reject lifecycle lands next).
 */
export { parseInvoiceCsv } from './import/parse.js';
export type {
  CanonicalField,
  Direction,
  ExternalRecordDraft,
  ImportRowError,
  ParseOptions,
  ParseResult,
} from './import/types.js';

export { suggestForRecord, MAX_SUBSET_EVENTS } from './match/engine.js';
export { deriveRecordStatus, type DerivedRecordStatus } from './match/status.js';
export {
  WEIGHTS,
  DEFAULT_AMOUNT_PCT,
  DEFAULT_DATE_WINDOW_DAYS,
} from './match/score.js';
export type {
  CandidateEvent,
  MatchRecord,
  RuleHit,
  SuggestedLeg,
  Tolerances,
} from './match/types.js';

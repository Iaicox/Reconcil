/**
 * Reconciliation: `external_record ↔ settlement` matching with m:n legs and
 * deterministic scoring; an invoice is just one `kind` of external record
 * (ADR-010). Matches are confirmed by a human before they reach exports.
 *
 * Face B slice 1 ships the invoice importer; the matching engine, HITL lifecycle
 * and status derivation land in the following slices.
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

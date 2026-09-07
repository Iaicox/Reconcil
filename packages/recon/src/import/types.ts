/**
 * Import-side domain types for Face B (ADR-010). An `ExternalRecordDraft` is a
 * normalized, validated, pre-insert invoice row — tenant/client identity is added
 * at the repository boundary (ADR-006), never carried in the draft. `amount`,
 * `vatRate`, `vatAmount` are decimal strings, never numbers (ADR-004); a float
 * would be a bug. `counterpartyName` stays RAW here (hostile import string, P7):
 * it is stored for audit and only ever leaves the server sanitized, under an
 * `untrusted` key (ADR-011, C6) — the sanitizer runs at the response boundary.
 */

export type Direction = 'receivable' | 'payable';

/** Canonical invoice fields the CSV columns map onto. */
export type CanonicalField =
  | 'external_ref'
  | 'counterparty_name'
  | 'amount'
  | 'currency'
  | 'vat_rate'
  | 'vat_amount'
  | 'issued_on'
  | 'due_on'
  | 'direction'
  | 'expected_address';

export interface ExternalRecordDraft {
  kind: string; // 'invoice' for now (Option C seam: future kinds reuse the engine)
  direction: Direction;
  source: 'csv';
  externalRef: string; // sanitized at the parser edge (hostile import text, C6/ADR-011) — the DEDUPE KEY, so the scrubbed value is what's stored
  counterpartyName: string | null; // RAW (hostile) — audit only, sanitized at the edge
  amount: string; // non-negative decimal string, gross in `currency`
  currency: string; // ISO-ish upper (EUR/USD/...)
  vatRate: string | null; // percent as decimal string, e.g. '21.0'
  vatAmount: string | null; // decimal string
  issuedOn: string | null; // ISO date (YYYY-MM-DD)
  dueOn: string | null; // ISO date (YYYY-MM-DD)
  expectedAddress: string | null; // lowercased 0x-address
  payload: Record<string, unknown>; // the raw import row, kept for audit
}

/** A row (or file) the importer refused, reported back instead of thrown (contract §6.4). */
export interface ImportRowError {
  row: number; // 1-based data row (0 = file-level, e.g. a missing required column)
  code: string;
  message: string;
}

export interface ParseOptions {
  /** Original CSV column name → canonical field; overrides auto-detection. */
  mapping?: Record<string, string>;
  defaults?: { currency?: string; direction?: Direction; vatRate?: string };
  /** DoS guard: reject the whole file past this many data rows (default 50_000). */
  maxRows?: number;
}

export interface ParseResult {
  drafts: ExternalRecordDraft[];
  errors: ImportRowError[];
}

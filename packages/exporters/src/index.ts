/**
 * Exporters: monthly close pack, PDF summary, QBO/Xero journal CSV drafts,
 * audit manifests. Every journal artifact is labeled as a draft (P8); rounding
 * happens only here, at the export boundary (ADR-004).
 *
 * Pure rendering layer: functions take already-computed domain shapes and return
 * in-memory files (name + bytes + sha256) + a manifest. No fs/db/network — the
 * mcp-tools composition layer computes (ledger + pricing), materializes the files,
 * and registers the `exports` row. Imports only `@reconcil/core` (ADR-011 boundary).
 */
export { renderClosePack } from './close-pack.js';
export { renderPdfSummary } from './pdf-summary.js';
export { renderJournalDrafts } from './journal-drafts.js';
export { buildJournalDraft, balanceJournal, type JournalLine, type JournalResult } from './journal.js';
export { toCsv, type CsvValue } from './csv.js';
export { sha256 } from './sha256.js';
export { roundHalfUp, compareDecimals } from './decimal.js';
export { buildManifest, serializeManifest, type ManifestArgs } from './manifest.js';

export type {
  Currency,
  ExportPeriod,
  ExportScope,
  TokenLabel,
  BalanceExportRow,
  TransactionExportRow,
  GasExportRow,
  CounterpartyExportRow,
  JournalMovement,
  JournalInput,
  Provenance,
  ClosePackInput,
  PdfSummaryInput,
  RenderedFile,
  RenderedExport,
  RoundingResidue,
  Manifest,
  JournalTarget,
  JournalCategory,
  JournalEntryInput,
  JournalDraftsInput,
  JournalManifest,
  JournalDraftsResult,
} from './types.js';

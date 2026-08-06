/**
 * Exporter render inputs and outputs. The exporters package is the file-artifact
 * boundary: it takes already-computed domain shapes (balances, transactions, gas,
 * counterparties, valued flows) and renders deterministic files. It imports only
 * `@reconcil/core` (the wire citation shapes) — never ledger/pricing/db — so the
 * mcp-tools composition layer maps its ledger/pricing results into these shapes.
 *
 * Money crosses as decimal strings (ADR-004); rounding happens only in this package
 * (the export boundary). `*_display`/symbol values are already sanitized (C6, ADR-011).
 */
import type { CoverageRef, FxRef, PriceRef } from '@reconcil/core';

export type Currency = 'USD' | 'EUR';

/** Resolved close period, whole UTC days `[start, end]`. */
export interface ExportPeriod {
  start: string; // ISO date
  end: string; // ISO date
}

/** Sanitized token identity for a CSV cell (never a `*_raw` hostile string). */
export interface TokenLabel {
  chainId: number;
  address: string | null; // null = native
  symbol: string; // sanitized *_display ('' when unknown)
  decimals: number;
  isStablecoin: boolean;
}

export interface BalanceExportRow {
  address: string;
  chainId: number;
  token: TokenLabel;
  amount: string; // exact decimal string
  fiatValue?: string; // decimal string in `currency`; omitted when unpriced
}

export interface TransactionExportRow {
  chainId: number;
  txHash: string;
  logIndex: number;
  blockTime: string; // ISO 8601 UTC
  kind: string;
  token: TokenLabel;
  amount: string;
  direction: 'in' | 'out' | 'internal';
  from: string;
  to: string;
}

export interface GasExportRow {
  chainId: number;
  nativeSymbol: string;
  nativeAmount: string;
  txCount: number;
  fiatValue?: string;
}

/** One (counterparty, token) turnover row — the flat CSV shape. */
export interface CounterpartyExportRow {
  counterparty: string; // address-book label or bare address (sanitized)
  labeled: boolean;
  tokenSymbol: string;
  inflow: string;
  outflow: string;
  fiatInflow?: string;
  fiatOutflow?: string;
  txCount: number; // per counterparty (repeated across its token rows)
}

/** Net valued movement of one token over the period (signed, in the target currency). */
export interface JournalMovement {
  tokenSymbol: string;
  netFiat: string; // signed decimal string: inflow − outflow, full precision
}

export interface JournalInput {
  movements: JournalMovement[];
  gasFiat?: string; // total gas expense in the target currency, full precision
}

/** Provenance carried into the manifest (P2): the export's own ids + pinned refs. */
export interface Provenance {
  exportId: string;
  toolCallId: string;
  generatedAt: string; // ISO 8601
  coverage: CoverageRef[];
  priceRefs: PriceRef[];
  fxRefs: FxRef[];
}

export interface ExportScope {
  addresses: string[];
  clientId?: string | null;
}

export interface ClosePackInput {
  period: ExportPeriod;
  currency: Currency;
  scope: ExportScope;
  balancesOpening: BalanceExportRow[];
  balancesClosing: BalanceExportRow[];
  transactions: TransactionExportRow[];
  gas: GasExportRow[];
  counterparties: CounterpartyExportRow[];
  journal: JournalInput;
  provenance: Provenance;
}

export interface PdfSummaryInput {
  period: ExportPeriod;
  currency: Currency;
  scope: ExportScope;
  openingTotalFiat?: string;
  closingTotalFiat?: string;
  netFlowsFiat?: string;
  gasTotalFiat?: string;
  topCounterparties: { name: string; fiatTurnover: string }[];
  provenance: Provenance;
}

export interface RenderedFile {
  name: string;
  content: string | Uint8Array;
  sha256: string;
}

export interface RoundingResidue {
  currency: string;
  residue: string; // decimal string, 2dp
}

export interface Manifest {
  schema_version: 1;
  export_id: string;
  tool_call_id: string;
  kind: 'close_pack' | 'pdf_summary';
  period: ExportPeriod;
  currency: Currency;
  scope: { addresses: string[]; client_id?: string };
  generated_at: string;
  draft: true;
  coverage: CoverageRef[];
  price_refs: PriceRef[];
  fx_refs: FxRef[];
  rounding_residues: RoundingResidue[];
  files: { name: string; sha256: string }[];
}

export interface RenderedExport {
  files: RenderedFile[];
  manifest: Manifest;
  roundingResidues: RoundingResidue[];
}

// ----------------------------------------------- recon-backed journal drafts ---
// `export_journal_drafts` (§6.5): confirmed matches → a QBO/Xero manual-journal CSV
// draft. Valued from the confirmed legs' pinned fiat (face value, P5) — no fresh
// pricing pass, so `price_refs`/`fx_refs` are empty. Every artifact is a DRAFT (P8).

export type JournalTarget = 'qbo' | 'xero';

/** The mappable double-entry line roles. `account_mapping[category] → account code`. */
export type JournalCategory =
  | 'crypto_asset'
  | 'accounts_receivable'
  | 'accounts_payable'
  | 'vat_output'
  | 'vat_input';

/**
 * One confirmed settlement to journalize. `grossFiat` is the confirmed leg's stored
 * `fiat_value` (full precision); the render layer rounds it to 2dp (the only rounding
 * site) and splits net/VAT from `vatRate`. `externalRef`/`counterparty` are hostile
 * import strings — the render layer sanitizes them before they reach a cell (P7/C6).
 */
export interface JournalEntryInput {
  externalRef: string;
  counterparty: string;
  direction: 'receivable' | 'payable';
  grossFiat: string;
  vatRate: number | null; // percent, e.g. 21; null/0 ⇒ no VAT split
  currency: string;
  date: string; // settlement date (block_time), ISO
}

export interface JournalDraftsInput {
  target: JournalTarget;
  period: ExportPeriod;
  scope: ExportScope;
  entries: JournalEntryInput[];
  accountMapping?: Record<string, string>; // category → account code
  provenance: Provenance;
}

/** The journal export's audit manifest (persisted to `exports.manifest`, not a file). */
export interface JournalManifest {
  schema_version: 1;
  export_id: string;
  tool_call_id: string;
  kind: 'journal_qbo' | 'journal_xero';
  target: JournalTarget;
  period: ExportPeriod;
  scope: { addresses: string[]; client_id?: string };
  generated_at: string;
  draft: true;
  coverage: CoverageRef[];
  price_refs: PriceRef[]; // empty: stablecoin face value (P5)
  fx_refs: FxRef[]; // empty
  rounding_residues: RoundingResidue[];
  account_mapping: Record<string, string>;
  unmapped_categories: string[];
  lines: number;
  file: { name: string; sha256: string };
}

export interface JournalDraftsResult {
  file: RenderedFile;
  lines: number; // journal lines emitted (excludes the DRAFT banner + header)
  unmappedCategories: string[];
  roundingResidues: RoundingResidue[];
  manifest: JournalManifest;
}

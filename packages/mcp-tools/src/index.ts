/**
 * Transport-agnostic MCP tool implementations (02-mcp-contracts). Each tool is a
 * `(ctx, input)` handler returning a citation envelope; the server/cli/evals
 * register these objects against their transport. Tenant identity is injected via
 * `ToolContext`, never read from arguments (ADR-006/012).
 */
import {
  analyticsBalancesInput, analyticsCounterpartiesInput, analyticsFlowsInput, analyticsGasInput,
  analyticsListEventsInput, analyticsStablecoinInput,
  directoryListEntitiesInput, directoryUpsertEntityInput,
  exportClosePackInput, exportJournalDraftsInput, exportPdfSummaryInput,
  ledgerStatusInput, ledgerTraceToolCallInput, ledgerTrackWalletInput,
  reconConfirmMatchInput, reconImportInvoicesInput, reconRejectMatchInput, reconStatusInput, reconSuggestMatchesInput,
} from '@reconcil/core';
import { z } from 'zod';

import type { ToolContext } from './context.js';
import type { ToolEnvelope } from './envelope.js';
import { analyticsBalances, TOOL_NAME as BALANCES_TOOL } from './tools/analytics-balances.js';
import { analyticsCounterparties, TOOL_NAME as COUNTERPARTIES_TOOL } from './tools/analytics-counterparties.js';
import { analyticsFlows, TOOL_NAME as FLOWS_TOOL } from './tools/analytics-flows.js';
import { analyticsGas, TOOL_NAME as GAS_TOOL } from './tools/analytics-gas.js';
import { analyticsListEvents, TOOL_NAME as LIST_EVENTS_TOOL } from './tools/analytics-list-events.js';
import { analyticsStablecoinMovements, TOOL_NAME as STABLECOIN_TOOL } from './tools/analytics-stablecoin-movements.js';
import { directoryListEntities, TOOL_NAME as DIRECTORY_LIST_TOOL } from './tools/directory-list-entities.js';
import { directoryUpsertEntity, TOOL_NAME as DIRECTORY_UPSERT_TOOL } from './tools/directory-upsert-entity.js';
import { exportClosePack, TOOL_NAME as EXPORT_CLOSE_PACK_TOOL } from './tools/export-close-pack.js';
import { exportJournalDrafts, TOOL_NAME as EXPORT_JOURNAL_DRAFTS_TOOL } from './tools/export-journal-drafts.js';
import { exportPdfSummary, TOOL_NAME as EXPORT_PDF_SUMMARY_TOOL } from './tools/export-pdf-summary.js';
import { ledgerStatus, TOOL_NAME as LEDGER_STATUS_TOOL } from './tools/ledger-status.js';
import { ledgerTraceToolCall, TOOL_NAME as LEDGER_TRACE_TOOL } from './tools/ledger-trace-tool-call.js';
import { ledgerTrackWallet, TOOL_NAME as LEDGER_TRACK_TOOL } from './tools/ledger-track-wallet.js';
import { reconConfirmMatch, TOOL_NAME as RECON_CONFIRM_TOOL } from './tools/recon-confirm-match.js';
import { reconImportInvoices, TOOL_NAME as RECON_IMPORT_TOOL } from './tools/recon-import-invoices.js';
import { reconRejectMatch, TOOL_NAME as RECON_REJECT_TOOL } from './tools/recon-reject-match.js';
import { reconStatus as reconStatusHandler, TOOL_NAME as RECON_STATUS_TOOL } from './tools/recon-status.js';
import { reconSuggestMatches, TOOL_NAME as RECON_SUGGEST_TOOL } from './tools/recon-suggest-matches.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
}

/** Every tool is a `(ctx, input) → envelope` handler; the data payload is tool-specific. */
export type ToolHandler = (ctx: ToolContext, input: unknown) => Promise<ToolEnvelope<unknown>>;

export interface ToolDescriptor {
  name: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>; // JSON Schema, published in the MCP declaration
  handler: ToolHandler;
}

/** All analytics_* tools are read-only (P8), never destructive. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };

/** Write tools (contract §1/§2): mutate tenant-owned data, never destructive. */
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };

export const analyticsBalancesTool: ToolDescriptor = {
  name: BALANCES_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(analyticsBalancesInput) as Record<string, unknown>,
  handler: analyticsBalances,
};

export const analyticsFlowsTool: ToolDescriptor = {
  name: FLOWS_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(analyticsFlowsInput) as Record<string, unknown>,
  handler: analyticsFlows,
};

export const analyticsGasTool: ToolDescriptor = {
  name: GAS_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(analyticsGasInput) as Record<string, unknown>,
  handler: analyticsGas,
};

export const analyticsStablecoinMovementsTool: ToolDescriptor = {
  name: STABLECOIN_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(analyticsStablecoinInput) as Record<string, unknown>,
  handler: analyticsStablecoinMovements,
};

export const analyticsListEventsTool: ToolDescriptor = {
  name: LIST_EVENTS_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(analyticsListEventsInput) as Record<string, unknown>,
  handler: analyticsListEvents,
};

export const analyticsCounterpartiesTool: ToolDescriptor = {
  name: COUNTERPARTIES_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(analyticsCounterpartiesInput) as Record<string, unknown>,
  handler: analyticsCounterparties,
};

export const directoryListEntitiesTool: ToolDescriptor = {
  name: DIRECTORY_LIST_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(directoryListEntitiesInput) as Record<string, unknown>,
  handler: directoryListEntities,
};

export const directoryUpsertEntityTool: ToolDescriptor = {
  name: DIRECTORY_UPSERT_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(directoryUpsertEntityInput) as Record<string, unknown>,
  handler: directoryUpsertEntity,
};

export const ledgerStatusTool: ToolDescriptor = {
  name: LEDGER_STATUS_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(ledgerStatusInput) as Record<string, unknown>,
  handler: ledgerStatus,
};

export const ledgerTraceToolCallTool: ToolDescriptor = {
  name: LEDGER_TRACE_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(ledgerTraceToolCallInput) as Record<string, unknown>,
  handler: ledgerTraceToolCall,
};

export const ledgerTrackWalletTool: ToolDescriptor = {
  name: LEDGER_TRACK_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(ledgerTrackWalletInput) as Record<string, unknown>,
  handler: ledgerTrackWallet,
};

/**
 * Export tools (contract §6.5): non-read-only (they write files and register an
 * `exports` row) but never destructive — they mutate no domain data.
 */
export const exportClosePackTool: ToolDescriptor = {
  name: EXPORT_CLOSE_PACK_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(exportClosePackInput) as Record<string, unknown>,
  handler: exportClosePack,
};

export const exportPdfSummaryTool: ToolDescriptor = {
  name: EXPORT_PDF_SUMMARY_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(exportPdfSummaryInput) as Record<string, unknown>,
  handler: exportPdfSummary,
};

/** recon_* (contract §6.4, Face B): import is a write (mutates external_records), never destructive. */
export const reconImportInvoicesTool: ToolDescriptor = {
  name: RECON_IMPORT_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(reconImportInvoicesInput) as Record<string, unknown>,
  handler: reconImportInvoices,
};

/** recon_suggest_matches (ADR-010): a write (persists `suggested` legs), never destructive. */
export const reconSuggestMatchesTool: ToolDescriptor = {
  name: RECON_SUGGEST_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(reconSuggestMatchesInput) as Record<string, unknown>,
  handler: reconSuggestMatches,
};

/** recon_confirm_match (ADR-010, HITL): a write (suggested → confirmed), never destructive. */
export const reconConfirmMatchTool: ToolDescriptor = {
  name: RECON_CONFIRM_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(reconConfirmMatchInput) as Record<string, unknown>,
  handler: reconConfirmMatch,
};

/** recon_reject_match (ADR-010, HITL): a write (suggested → rejected), never destructive. */
export const reconRejectMatchTool: ToolDescriptor = {
  name: RECON_REJECT_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(reconRejectMatchInput) as Record<string, unknown>,
  handler: reconRejectMatch,
};

/** recon_status (§6.4): a read — the authoritative reconciliation snapshot. */
export const reconStatusTool: ToolDescriptor = {
  name: RECON_STATUS_TOOL,
  annotations: READ_ONLY,
  inputSchema: z.toJSONSchema(reconStatusInput) as Record<string, unknown>,
  handler: reconStatusHandler,
};

/** export_journal_drafts (§6.5): a write — recon-backed QBO/Xero journal draft, never destructive. */
export const exportJournalDraftsTool: ToolDescriptor = {
  name: EXPORT_JOURNAL_DRAFTS_TOOL,
  annotations: WRITE,
  inputSchema: z.toJSONSchema(exportJournalDraftsInput) as Record<string, unknown>,
  handler: exportJournalDrafts,
};

/** The registry the server/cli/evals iterate to declare tools. */
export const tools: ToolDescriptor[] = [
  analyticsBalancesTool,
  analyticsFlowsTool,
  analyticsGasTool,
  analyticsStablecoinMovementsTool,
  analyticsListEventsTool,
  analyticsCounterpartiesTool,
  directoryListEntitiesTool,
  directoryUpsertEntityTool,
  ledgerStatusTool,
  ledgerTraceToolCallTool,
  ledgerTrackWalletTool,
  exportClosePackTool,
  exportPdfSummaryTool,
  reconImportInvoicesTool,
  reconSuggestMatchesTool,
  reconConfirmMatchTool,
  reconRejectMatchTool,
  reconStatusTool,
  exportJournalDraftsTool,
];

export { analyticsBalances } from './tools/analytics-balances.js';
export { analyticsFlows } from './tools/analytics-flows.js';
export { analyticsGas } from './tools/analytics-gas.js';
export { analyticsStablecoinMovements } from './tools/analytics-stablecoin-movements.js';
export { analyticsListEvents } from './tools/analytics-list-events.js';
export { analyticsCounterparties } from './tools/analytics-counterparties.js';
export { directoryListEntities } from './tools/directory-list-entities.js';
export { directoryUpsertEntity } from './tools/directory-upsert-entity.js';
export { exportClosePack } from './tools/export-close-pack.js';
export { exportPdfSummary } from './tools/export-pdf-summary.js';
export { ledgerStatus } from './tools/ledger-status.js';
export { ledgerTraceToolCall } from './tools/ledger-trace-tool-call.js';
export { ledgerTrackWallet } from './tools/ledger-track-wallet.js';
export { reconImportInvoices } from './tools/recon-import-invoices.js';
export { reconSuggestMatches } from './tools/recon-suggest-matches.js';
export { reconConfirmMatch } from './tools/recon-confirm-match.js';
export { reconRejectMatch } from './tools/recon-reject-match.js';
export { reconStatus } from './tools/recon-status.js';
export { exportJournalDrafts } from './tools/export-journal-drafts.js';
export { computeJournalData, type JournalData, type JournalDataInput } from './tools/journal-drafts-data.js';
export { importExternalRecords, type ImportResult, type ImportedRecord } from './recon/repo.js';
export { computeReconStatus, type ReconStatusParams, type ReconStatusResult } from './recon/status-repo.js';
export { suggestMatches, type SuggestMatchesParams, type SuggestMatchesResult, type SuggestionRow } from './recon/match-repo.js';
export { decideMatchInTx, type MatchDecisionParams, type MatchDecisionResult } from './recon/decision-repo.js';
export { resolveEntities, refKey, type ResolvedEntity, type EntityRef } from './directory/resolve.js';
export { listEntities, upsertEntity, type UpsertResult } from './directory/repo.js';
export { buildEnvelope, type ToolEnvelope, type Citations, type EnvelopeParts } from './envelope.js';
export { resolveScope, type ResolvedScope } from './scope.js';
export { persistToolCall, canonicalStringify, type PersistParams } from './tool-calls.js';
export { mapCoverage } from './coverage.js';
export { toTokenView } from './token-view.js';
export { selectRefs, dedupeRefs, REF_CAP } from './refs.js';
export { ulid } from './ulid.js';
export { describeTool, UNTRUSTED_NOTE } from './descriptions.js';
export { ToolError, type ErrorCode } from './errors.js';
export type { ToolContext, TxContext, DbContext } from './context.js';
export { runWriteTool, withRetry, type WriteToolSpec, type WriteToolResult } from './write-tx.js';

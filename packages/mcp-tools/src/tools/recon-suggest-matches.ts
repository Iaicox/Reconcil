/**
 * `recon_suggest_matches` (contract §6.4, write, ADR-010) — run the deterministic
 * matching engine and persist its suggestions (`matches`, status='suggested'). The
 * engine (@reconcil/recon) scores; this handler owns the edges: resolving/validating
 * the client scope, mapping wire tolerances to the engine, building the citable event
 * view (sanitized token symbols via toTokenView), validating the output against the
 * contract, and persisting the tool_call before responding (C2). Nothing here matches
 * or confirms on the model's behalf (P1/P8): humans confirm via recon_confirm_match.
 */
import {
  reconSuggestMatchesInput, reconSuggestMatchesOutput,
  type MatchSuggestionView, type ReconSuggestMatchesOutput,
} from '@reconcil/core';
import type { Tolerances } from '@reconcil/recon';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { suggestMatches, type SuggestMatchesParams } from '../recon/match-repo.js';
import { selectRefs } from '../refs.js';
import { resolveClientId } from '../scope.js';
import { toTokenView } from '../token-view.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'recon_suggest_matches';

export async function reconSuggestMatches(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ReconSuggestMatchesOutput>> {
  const parsed = reconSuggestMatchesInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  // Resolve client scope to the tenant's own before any write (ADR-006); only when
  // provided — absent client_id scopes to all of the tenant's records, not the
  // unattributed ones. A bad/foreign id is INVALID_INPUT (resolveClientId throws).
  // `?? undefined` coerces resolveClientId's `string | null` to the params' `string?`
  // (it never returns null on a provided id — this is a type bridge, not a runtime path).
  const clientId = input.client_id !== undefined
    ? ((await resolveClientId(ctx, input.client_id)) ?? undefined)
    : undefined;

  const tolerances: Tolerances = {};
  if (input.tolerances?.amount_pct !== undefined) tolerances.amountPct = input.tolerances.amount_pct;
  if (input.tolerances?.amount_abs !== undefined) tolerances.amountAbs = input.tolerances.amount_abs;
  if (input.tolerances?.date_window_days !== undefined) tolerances.dateWindowDays = input.tolerances.date_window_days;

  const params: SuggestMatchesParams = { tolerances };
  if (input.period !== undefined) params.period = input.period;
  if (clientId !== undefined) params.clientId = clientId;
  if (input.record_ids !== undefined) params.recordIds = input.record_ids;

  const { rows, unmatchedRecords, unmatchedSettlements } = await suggestMatches(ctx, params);

  const suggestions: MatchSuggestionView[] = rows.map((s) => ({
    match_id: s.matchId,
    record: {
      id: s.record.id,
      external_ref: s.record.externalRef,
      amount: s.record.amount,
      currency: s.record.currency,
      open_amount: s.record.openAmount,
    },
    event: {
      chain_id: s.event.chainId,
      tx_hash: s.event.txHash,
      log_index: s.event.logIndex,
      token: toTokenView(s.event.token),
      amount: s.event.amount,
      block_time: s.event.blockTime,
      from: { address: s.event.fromAddr },
    },
    amount_applied: s.amountApplied,
    fiat_value: s.fiatValue,
    confidence: s.confidence,
    rationale: s.rationale,
  }));

  const data: ReconSuggestMatchesOutput = {
    suggestions,
    unmatched_records: unmatchedRecords,
    unmatched_settlements: unmatchedSettlements,
  };

  try {
    reconSuggestMatchesOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `recon_suggest_matches produced an output that violates its contract: ${String(err)}`);
  }

  // Each suggestion cites its backing settlement event (C1/C3): inline when ≤ cap,
  // else a summary whose drilldown re-enumerates the events via analytics_list_events.
  const refs = selectRefs(
    [{ refs: rows.map((s) => ({ chainId: s.event.chainId, txHash: s.event.txHash, logIndex: s.event.logIndex })), totalCount: rows.length }],
    { tool: 'analytics_list_events', args: input.period !== undefined ? { period: input.period } : {} },
  );

  // FOLLOW-UP (write-tool atomicity, C2): suggestMatches commits its own transaction, then
  // this audit write runs separately — a failure here (or in the output.parse above) after
  // the commit leaves matches rows with no tool_call. Shared with the other write tools
  // (recon_import_invoices, directory_upsert_entity, ...); the fix is to thread one
  // transaction through persistToolCall, built once across all of them, not only here.
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: { ...input }, coverage: [], result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: [], ...refs });
}

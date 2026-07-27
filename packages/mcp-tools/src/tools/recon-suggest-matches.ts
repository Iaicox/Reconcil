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
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { suggestMatches, type SuggestMatchesParams } from '../recon/match-repo.js';
import { selectRefs } from '../refs.js';
import { resolveClientId } from '../scope.js';
import { toTokenView } from '../token-view.js';
import { runWriteTool } from '../write-tx.js';

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

  // The suggestion delete+insert and the tool_call audit row commit in one transaction (C2):
  // a failure — including the output-contract check below — rolls the suggestions back rather
  // than leaving matches rows with no audit record.
  return runWriteTool<ReconSuggestMatchesOutput>(ctx, {
    toolName: TOOL_NAME,
    args: { ...input },
    body: async (txCtx) => {
      const { rows, unmatchedRecords, unmatchedSettlements, priceRefs, fxRefs, warnings } = await suggestMatches(txCtx, params);

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

      // Volatile-token legs carry pinned price/FX snapshots + any PRICE_MISSING warnings (C4/C5).
      return { data, envelope: { coverage: [], ...refs, priceRefs, fxRefs, warnings } };
    },
  });
}

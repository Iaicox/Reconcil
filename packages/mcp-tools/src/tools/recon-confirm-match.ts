/**
 * `recon_confirm_match` (contract §6.4, write, HITL, ADR-010) — a human confirms one
 * suggested leg. The repo (SERIALIZABLE) enforces the matching invariants and re-derives
 * the parent record's status; this handler owns the edges: input validation, output
 * contract validation, and persisting the tool_call before responding (C2). The agent
 * never confirms on its own initiative (P1/P8) — it relays a human decision.
 */
import { reconConfirmMatchInput, reconConfirmMatchOutput, type ReconMatchDecisionOutput } from '@reconcil/core';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { applyMatchDecision } from '../recon/decision-repo.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'recon_confirm_match';

export async function reconConfirmMatch(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ReconMatchDecisionOutput>> {
  const parsed = reconConfirmMatchInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const result = await applyMatchDecision(ctx, {
    matchId: input.match_id,
    decision: 'confirmed',
    ...(input.note !== undefined ? { note: input.note } : {}),
  });

  const data: ReconMatchDecisionOutput = {
    match_id: result.matchId,
    status: result.status,
    record_status: result.recordStatus,
    valuation: {
      fiat_value: result.valuation.fiatValue,
      ...(result.valuation.priceRef !== undefined ? { price_ref: result.valuation.priceRef } : {}),
      ...(result.valuation.fxRef !== undefined ? { fx_ref: result.valuation.fxRef } : {}),
    },
  };

  try {
    reconConfirmMatchOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `recon_confirm_match produced an output that violates its contract: ${String(err)}`);
  }

  // FOLLOW-UP (write-tool atomicity, C2): applyMatchDecision commits its own transaction,
  // then this audit write runs separately — a failure here after the commit leaves the leg
  // actioned with no tool_call. Shared with the other write tools; the fix threads one
  // transaction through persistToolCall (ToolContext.db is Db, not a PgTransaction), worth
  // building once across all of them rather than only here.
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: { ...input }, coverage: [], result: data,
  });

  // Single leg, stablecoin face-value valuation ⇒ empty coverage, no refs. When volatile
  // pricing lands, thread valuation.price_ref/fx_ref into the envelope's price/fx refs (C4).
  return buildEnvelope(data, { toolCallId, coverage: [] });
}

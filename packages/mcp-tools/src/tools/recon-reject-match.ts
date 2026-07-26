/**
 * `recon_reject_match` (contract §6.4, write, HITL, ADR-010) — a human rejects one
 * suggested leg. A rejected leg is removed from every sum (invariant + record status) and
 * never reaches an export. Same edges as confirm: input/output contract validation and a
 * tool_call persisted before responding (C2). The agent relays a human decision (P1/P8).
 */
import { reconRejectMatchInput, reconRejectMatchOutput, type ReconMatchDecisionOutput } from '@reconcil/core';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { applyMatchDecision } from '../recon/decision-repo.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'recon_reject_match';

export async function reconRejectMatch(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ReconMatchDecisionOutput>> {
  const parsed = reconRejectMatchInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const result = await applyMatchDecision(ctx, { matchId: input.match_id, decision: 'rejected' });

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
    reconRejectMatchOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `recon_reject_match produced an output that violates its contract: ${String(err)}`);
  }

  // FOLLOW-UP (write-tool atomicity, C2): the mutation and this audit write are separate
  // transactions — a persistToolCall failure after the commit leaves the leg actioned with
  // no tool_call. Shared across the write tools; the fix (one transaction threaded through
  // persistToolCall) is worth building once rather than only here.
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: { ...input }, coverage: [], result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: [] });
}

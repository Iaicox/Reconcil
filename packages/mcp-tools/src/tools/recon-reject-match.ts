/**
 * `recon_reject_match` (contract §6.4, write, HITL, ADR-010) — a human rejects one
 * suggested leg. A rejected leg is removed from every sum (invariant + record status) and
 * never reaches an export. Same edges as confirm: input/output contract validation, with the
 * mutation and its tool_call committed atomically by `runWriteTool` (C2). The agent relays a
 * human decision (P1/P8).
 */
import { reconRejectMatchInput, reconRejectMatchOutput, type ReconMatchDecisionOutput } from '@reconcil/core';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { decideMatchInTx } from '../recon/decision-repo.js';
import { runWriteTool } from '../write-tx.js';

export const TOOL_NAME = 'recon_reject_match';

export async function reconRejectMatch(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ReconMatchDecisionOutput>> {
  const parsed = reconRejectMatchInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  return runWriteTool<ReconMatchDecisionOutput>(ctx, {
    toolName: TOOL_NAME,
    args: { ...input },
    isolation: 'serializable',
    body: async (txCtx) => {
      const result = await decideMatchInTx(txCtx, { matchId: input.match_id, decision: 'rejected' });

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

      return { data, envelope: { coverage: [] } };
    },
  });
}

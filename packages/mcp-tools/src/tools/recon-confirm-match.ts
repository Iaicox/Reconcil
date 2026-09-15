/**
 * `recon_confirm_match` (contract §6.4, write, HITL, ADR-010) — confirms one suggested
 * leg. `decideMatchInTx` (SERIALIZABLE) enforces the matching invariants and
 * re-derives the parent record's status; `runWriteTool` owns the transaction (with
 * serialization-failure retry) and persists the tool_call in that same transaction, so the
 * decision and its audit row commit atomically (C2). This handler owns the edges: input
 * validation and output-contract validation.
 *
 * The agent never MATCHES (P1) — the engine proposes, this records a decision. Who makes that
 * decision is the transport client's approval gate, not anything here: `confirmed_by` is a
 * hardcoded 'agent' and the in-process CLI binding has no gate at all. ADR-010 d4 was
 * amended on 2026-09-15 to say so; tracked in 09-known-gaps.md.
 */
import { reconConfirmMatchInput, reconConfirmMatchOutput, type ReconMatchDecisionOutput } from '@reconcil/core';

import type { ToolContext } from '../context.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { decideMatchInTx } from '../recon/decision-repo.js';
import { runWriteTool } from '../write-tx.js';

export const TOOL_NAME = 'recon_confirm_match';

export async function reconConfirmMatch(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ReconMatchDecisionOutput>> {
  const parsed = reconConfirmMatchInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  return runWriteTool<ReconMatchDecisionOutput>(ctx, {
    toolName: TOOL_NAME,
    args: { ...input },
    isolation: 'serializable',
    body: async (txCtx) => {
      const result = await decideMatchInTx(txCtx, { matchId: input.match_id, decision: 'confirmed' });

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
        throw new ToolError('INTERNAL', 'recon_confirm_match produced an output that violates its contract', undefined, err);
      }

      // A volatile-token leg cites the snapshot/FX that backs the confirmed value (C4); a
      // stablecoin face-value leg has none, so the envelope pools stay empty.
      const priceRefs = result.valuation.priceRef !== undefined ? [result.valuation.priceRef] : [];
      const fxRefs = result.valuation.fxRef !== undefined ? [result.valuation.fxRef] : [];
      return { data, envelope: { coverage: [], priceRefs, fxRefs } };
    },
  });
}

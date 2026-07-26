/**
 * `recon_status` (contract §6.4, read) — the authoritative reconciliation snapshot:
 * record counts by lifecycle status, outstanding open amounts per currency, the
 * settlements not yet reconciled (no confirmed leg), and any overpayments. This is the
 * view recon_suggest_matches defers to for the definitive unmatched-settlement count.
 *
 * A read tool: it mutates no domain data, but still resolves/validates the client scope
 * (ADR-006) and persists the tool_call before responding (C2), like analytics_list_events.
 * `unmatched_settlements` is self-citing — it carries the event sample plus an executable
 * analytics_list_events drilldown (C3), so no extra envelope refs are needed.
 */
import { reconStatusInput, reconStatusOutput, type ReconStatusOutput } from '@reconcil/core';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { computeReconStatus, type ReconStatusParams } from '../recon/status-repo.js';
import { resolveClientId } from '../scope.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'recon_status';

export async function reconStatus(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<ReconStatusOutput>> {
  const parsed = reconStatusInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  // Resolve client scope to the tenant's own; a bad/foreign id is INVALID_INPUT
  // (resolveClientId throws). `?? undefined` bridges its `string | null` to the
  // params' `string?` — it never returns null on a provided id.
  const clientId = input.client_id !== undefined
    ? ((await resolveClientId(ctx, input.client_id)) ?? undefined)
    : undefined;

  const params: ReconStatusParams = {};
  if (input.period !== undefined) params.period = input.period;
  if (clientId !== undefined) params.clientId = clientId;

  const result = await computeReconStatus(ctx, params);

  const data: ReconStatusOutput = {
    records: result.records,
    open_amounts: result.openAmounts,
    unmatched_settlements: {
      count: result.unmatchedSettlements.count,
      sample: result.unmatchedSettlements.sample.map((e) => ({
        chain_id: e.chainId, tx_hash: e.txHash, log_index: e.logIndex,
      })),
      // Executable re-enumeration of the backing events (C3); scoped by period when given.
      drilldown: { tool: 'analytics_list_events', args: input.period !== undefined ? { period: input.period } : {} },
    },
    overpayments: result.overpayments.map((o) => ({
      record_id: o.recordId, external_ref: o.externalRef, excess: o.excess, currency: o.currency,
    })),
  };

  try {
    reconStatusOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `recon_status produced an output that violates its contract: ${String(err)}`);
  }

  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: { ...input }, coverage: [], result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: [] });
}

/**
 * `recon_status` (contract §6.4, read) — the authoritative reconciliation snapshot:
 * record counts by lifecycle status, outstanding open amounts per currency, both settlement
 * figures, and any overpayments.
 *
 * The settlements come in two disjoint halves. `unmatched_settlements` is those with NO
 * confirmed leg — the view recon_suggest_matches defers to for the definitive unmatched
 * count, which is why it is never widened. `partially_applied_settlements` is those with
 * some confirmed leg and value still unapplied: not a candidate suggest would offer, and
 * invisible from outside until it had a figure of its own.
 *
 * A read tool: it mutates no domain data, but still resolves/validates the client scope
 * (ADR-006) and persists the tool_call before responding (C2), like analytics_list_events.
 * Both figures are self-citing — each carries an event sample plus the same executable
 * analytics_list_events drilldown (C3), so no extra envelope refs are needed.
 */
import { reconStatusInput, reconStatusOutput, type ReconStatusOutput } from '@reconcil/core';
import { getLedgerStatus } from '@reconcil/ledger';

import type { ToolContext } from '../context.js';
import { mapCoverage } from '../coverage.js';
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

  // Executable re-enumeration of the backing events (C3): scoped to the SAME wallet subset
  // and period the figures were computed over (superset — list_events cannot express "no
  // confirmed leg"/"partly applied" — but never wider on client scope). Threads the
  // CANONICAL resolved `clientId`, not the caller's raw `input.client_id` (C3b): the two
  // diverge only on mixed-case input, but the raw value is never the right thing to hand
  // back into another tool call. Built once — the two settlement figures are one split of
  // one scope, so a copy-paste pair could silently disagree after any change here.
  const drilldown = {
    tool: 'analytics_list_events',
    args: {
      ...(clientId !== undefined ? { scope: { client_id: clientId } } : {}),
      ...(input.period !== undefined ? { period: input.period } : {}),
    },
  } as const;

  const data: ReconStatusOutput = {
    records: result.records,
    open_amounts: result.openAmounts,
    unmatched_settlements: {
      count: result.unmatchedSettlements.count,
      sample: result.unmatchedSettlements.sample.map((e) => ({
        chain_id: e.chainId, tx_hash: e.txHash, log_index: e.logIndex,
      })),
      drilldown,
    },
    partially_applied_settlements: {
      count: result.partiallyAppliedSettlements.count,
      sample: result.partiallyAppliedSettlements.sample.map((e) => ({
        chain_id: e.chainId, tx_hash: e.txHash, log_index: e.logIndex,
      })),
      drilldown,
    },
    overpayments: result.overpayments.map((o) => ({
      record_id: o.recordId, external_ref: o.externalRef, excess: o.excess, currency: o.currency,
    })),
  };

  try {
    reconStatusOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', 'recon_status produced an output that violates its contract', undefined, err);
  }

  // C5: unmatched_settlements reads chain_events, so its "authoritative" count is only as
  // complete as ingestion. Surface coverage/staleness over the same wallet set, exactly as
  // analytics_list_events does (getLedgerStatus → mapCoverage). Empty addresses → no coverage.
  const coverage = await getLedgerStatus(ctx.db, { addresses: result.addresses });
  const { coverageRefs, coverageWarnings } = mapCoverage(coverage);

  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: { ...input }, coverage: coverageRefs, result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: coverageRefs, warnings: coverageWarnings });
}

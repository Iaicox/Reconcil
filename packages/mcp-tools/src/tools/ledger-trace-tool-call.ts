/**
 * `ledger_trace_tool_call` (contract §6.2) — audit replay of any previous
 * answer, the concrete realization of C2/P2: given a persisted `tool_call_id`,
 * return the original tool, args, coverage snapshot and result digest so
 * "where did this number in last month's report come from?" is answerable
 * across sessions. Tenant-scoped (ADR-006): a call is invisible to any tenant
 * but the one that made it. `drilldown` is not persisted today, so it is omitted
 * (optional in the contract). The trace is itself persisted, uniformly (C2).
 */
import {
  ledgerTraceToolCallInput, ledgerTraceToolCallOutput,
  type CoverageRef, type LedgerTraceToolCallOutput,
} from '@pet-crypto/core';
import { toolCalls } from '@pet-crypto/db';
import { and, eq } from 'drizzle-orm';

import type { ToolContext } from '../context.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'ledger_trace_tool_call';

export async function ledgerTraceToolCall(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<LedgerTraceToolCallOutput>> {
  const parsed = ledgerTraceToolCallInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const [row] = await ctx.db
    .select({
      toolName: toolCalls.toolName,
      args: toolCalls.args,
      calledAt: toolCalls.calledAt,
      coverage: toolCalls.coverage,
      resultDigest: toolCalls.resultDigest,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.id, input.tool_call_id), eq(toolCalls.tenantId, ctx.tenantId)))
    .limit(1);
  if (!row) throw new ToolError('INVALID_INPUT', `tool_call_id not found: ${input.tool_call_id}`);

  const data: LedgerTraceToolCallOutput = {
    tool_name: row.toolName,
    args: row.args,
    called_at: row.calledAt.toISOString(),
    coverage: row.coverage as CoverageRef[],
    result_digest: row.resultDigest,
  };

  try {
    ledgerTraceToolCallOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `ledger_trace_tool_call produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: [], result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: [] });
}

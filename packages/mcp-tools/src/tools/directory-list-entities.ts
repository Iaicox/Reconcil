/**
 * `directory_list_entities` (contract §6.3) — list/search the tenant's address
 * book plus curated (`tenant_id NULL`) labels. Read-only; returns the citation
 * envelope with empty coverage (no ledger slice) and persists the tool_call for
 * audit (C2). Tenant-scoped in the repository (ADR-006).
 */
import {
  directoryListEntitiesInput, directoryListEntitiesOutput,
  type DirectoryListEntitiesOutput,
} from '@pet-crypto/core';

import type { ToolContext } from '../context.js';
import { listEntities } from '../directory/repo.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'directory_list_entities';

export async function directoryListEntities(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<DirectoryListEntitiesOutput>> {
  const parsed = directoryListEntitiesInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const data: DirectoryListEntitiesOutput = { entities: await listEntities(ctx, input) };

  try {
    directoryListEntitiesOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `directory_list_entities produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: [], result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: [], warnings: [] });
}

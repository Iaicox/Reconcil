/**
 * `directory_upsert_entity` (contract §6.3, write) — create or update a tenant
 * entity and its addresses. Names/notes pass the hostile-string sanitizer (§7),
 * raising SANITIZED_HEAVY when heavily stripped; curated (`tenant_id NULL`)
 * entities are immutable and address ownership is unique per `(tenant, chain,
 * address)` — both violations surface as INVALID_INPUT. Returns the citation
 * envelope with empty coverage and persists the tool_call for audit (C2).
 */
import {
  directoryUpsertEntityInput, directoryUpsertEntityOutput,
  type DirectoryUpsertEntityOutput,
} from '@pet-crypto/core';

import type { ToolContext } from '../context.js';
import { upsertEntity } from '../directory/repo.js';
import { buildEnvelope, type ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { persistToolCall } from '../tool-calls.js';

export const TOOL_NAME = 'directory_upsert_entity';

export async function directoryUpsertEntity(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<DirectoryUpsertEntityOutput>> {
  const parsed = directoryUpsertEntityInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  const { entityId, created, warnings } = await upsertEntity(ctx, input);
  const data: DirectoryUpsertEntityOutput = { entity_id: entityId, created };

  try {
    directoryUpsertEntityOutput.parse(data);
  } catch (err) {
    throw new ToolError('INTERNAL', `directory_upsert_entity produced an output that violates its contract: ${String(err)}`);
  }
  const toolCallId = await persistToolCall(ctx, {
    toolName: TOOL_NAME, args: input as Record<string, unknown>, coverage: [], result: data,
  });

  return buildEnvelope(data, { toolCallId, coverage: [], warnings });
}

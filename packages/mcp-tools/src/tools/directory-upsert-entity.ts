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
} from '@reconcil/core';

import type { ToolContext } from '../context.js';
import { upsertEntity } from '../directory/repo.js';
import type { ToolEnvelope } from '../envelope.js';
import { ToolError } from '../errors.js';
import { runWriteTool } from '../write-tx.js';

export const TOOL_NAME = 'directory_upsert_entity';

export async function directoryUpsertEntity(
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolEnvelope<DirectoryUpsertEntityOutput>> {
  const parsed = directoryUpsertEntityInput.safeParse(rawInput);
  if (!parsed.success) throw new ToolError('INVALID_INPUT', parsed.error.message);
  const input = parsed.data;

  // The entity/address mutation and the tool_call audit row commit in one transaction (C2):
  // a failure — including the output-contract check below — rolls the upsert back.
  return runWriteTool<DirectoryUpsertEntityOutput>(ctx, {
    toolName: TOOL_NAME,
    args: input as Record<string, unknown>,
    body: async (txCtx) => {
      const { entityId, created, warnings } = await upsertEntity(txCtx, input);
      const data: DirectoryUpsertEntityOutput = { entity_id: entityId, created };

      try {
        directoryUpsertEntityOutput.parse(data);
      } catch (err) {
        throw new ToolError('INTERNAL', `directory_upsert_entity produced an output that violates its contract: ${String(err)}`);
      }

      return { data, envelope: { coverage: [], warnings } };
    },
  });
}

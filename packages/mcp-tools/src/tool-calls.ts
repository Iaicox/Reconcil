/**
 * Persist a tool call BEFORE the response is returned (C2): id (ULID), args,
 * coverage snapshot, and a sha256 digest of the canonical result JSON. This is
 * what `ledger_trace_tool_call` replays to answer "where did this number come
 * from?" across sessions. Tenant-scoped by `ctx.tenantId`.
 */
import { createHash } from 'node:crypto';

import type { CoverageRef } from '@pet-crypto/core';
import { toolCalls } from '@pet-crypto/db';

import type { ToolContext } from './context.js';
import { ulid } from './ulid.js';

/** Deterministic stringify (sorted keys, undefined dropped) for a stable digest. */
export function canonicalStringify(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(v.toString()); // JSON.stringify(bigint) throws
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

export interface PersistParams {
  toolName: string;
  args: Record<string, unknown>;
  coverage: CoverageRef[];
  result: unknown;
}

export async function persistToolCall(ctx: ToolContext, params: PersistParams): Promise<string> {
  const id = ulid();
  const resultDigest = createHash('sha256').update(canonicalStringify(params.result)).digest('hex');
  await ctx.db.insert(toolCalls).values({
    id,
    tenantId: ctx.tenantId,
    toolName: params.toolName,
    args: params.args,
    resultDigest,
    coverage: params.coverage,
  });
  return id;
}

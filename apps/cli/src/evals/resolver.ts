/**
 * DB-backed CitationResolver for G3 (04-testing.md §5, contract C1/C3). The grader is
 * synchronous, so this pre-resolves the transcript's tool_call_ids and event refs against
 * Postgres up front and returns an in-memory view: `tool_calls` are tenant-scoped (C1),
 * `chain_events` are global (C3). Keeping this behind the ResolverFactory seam lets the
 * grader stay pure and unit-testable while the real lookups live here.
 */
import type { EventRef } from '@pet-crypto/core';
import { chainEvents, toolCalls } from '@pet-crypto/db';
import type { Transcript } from '@pet-crypto/evals';
import type { ToolContext } from '@pet-crypto/mcp-tools';
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';

import type { CitationResolver, ResolverFactory } from './types.js';

const refKey = (r: EventRef): string => `${String(r.chain_id)}:${r.tx_hash.toLowerCase()}:${String(r.log_index)}`;

export const dbResolver: ResolverFactory = async (
  ctx: ToolContext,
  transcript: Transcript,
): Promise<CitationResolver> => {
  const wantedToolCalls = new Set<string>();
  const wantedRefs = new Map<string, EventRef>();
  for (const inv of transcript.invocations) {
    const c = inv.envelope.citations;
    if (c.tool_call_id) wantedToolCalls.add(c.tool_call_id);
    for (const r of c.event_refs ?? []) wantedRefs.set(refKey(r), r);
    for (const r of c.event_ref_summary?.sample ?? []) wantedRefs.set(refKey(r), r);
  }

  // Persisted tool_calls that exist for THIS tenant (C1).
  const existingToolCalls = new Set<string>();
  if (wantedToolCalls.size > 0) {
    const rows = await ctx.db
      .select({ id: toolCalls.id })
      .from(toolCalls)
      .where(and(eq(toolCalls.tenantId, ctx.tenantId), inArray(toolCalls.id, [...wantedToolCalls])));
    for (const r of rows) existingToolCalls.add(r.id);
  }

  // chain_events that resolve (C3) — global table, matched by the (chain, tx, log) tuple.
  const resolvedRefs = new Set<string>();
  const refs = [...wantedRefs.values()];
  if (refs.length > 0) {
    const conditions: SQL[] = refs.map(
      (r) =>
        and(
          eq(chainEvents.chainId, r.chain_id),
          eq(chainEvents.txHash, r.tx_hash.toLowerCase()),
          eq(chainEvents.logIndex, r.log_index),
        )!,
    );
    const rows = await ctx.db
      .select({ chainId: chainEvents.chainId, txHash: chainEvents.txHash, logIndex: chainEvents.logIndex })
      .from(chainEvents)
      .where(or(...conditions));
    for (const r of rows) resolvedRefs.add(refKey({ chain_id: r.chainId, tx_hash: r.txHash, log_index: r.logIndex }));
  }

  return {
    toolCallExists: (id) => existingToolCalls.has(id),
    eventRefResolves: (ref) => resolvedRefs.has(refKey(ref)),
  };
};

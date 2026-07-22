/**
 * The response envelope (contract §2) — every tool returns `ToolEnvelope<T>`.
 * Citations carry provenance (C1): the persisted `tool_call_id`, coverage, event
 * refs (or a drilldown summary, C3), and pinned price/FX refs (C4). Warnings are
 * machine-readable (C5). `data` must already be sanitized (C6) — only `untrusted`
 * keys carry scrubbed hostile strings.
 */
import type {
  CoverageRef, EventRef, EventRefSummary, FxRef, PriceRef, Warning,
} from '@pet-crypto/core';

export interface Citations {
  tool_call_id: string;
  coverage: CoverageRef[];
  event_refs?: EventRef[];
  event_ref_summary?: EventRefSummary;
  price_refs?: PriceRef[];
  fx_refs?: FxRef[];
}

export interface ToolEnvelope<T> {
  data: T;
  citations: Citations;
  warnings: Warning[];
  meta: { schema_version: 1; computed_at: string; units: 'decimal-string' };
}

export interface EnvelopeParts {
  toolCallId: string;
  coverage: CoverageRef[];
  eventRefs?: EventRef[];
  eventRefSummary?: EventRefSummary;
  priceRefs?: PriceRef[];
  fxRefs?: FxRef[];
  warnings?: Warning[];
}

export function buildEnvelope<T>(data: T, parts: EnvelopeParts): ToolEnvelope<T> {
  const citations: Citations = { tool_call_id: parts.toolCallId, coverage: parts.coverage };
  if (parts.eventRefs !== undefined) citations.event_refs = parts.eventRefs;
  if (parts.eventRefSummary !== undefined) citations.event_ref_summary = parts.eventRefSummary;
  if (parts.priceRefs !== undefined && parts.priceRefs.length > 0) citations.price_refs = parts.priceRefs;
  if (parts.fxRefs !== undefined && parts.fxRefs.length > 0) citations.fx_refs = parts.fxRefs;
  return {
    data,
    citations,
    warnings: parts.warnings ?? [],
    meta: { schema_version: 1, computed_at: new Date().toISOString(), units: 'decimal-string' },
  };
}

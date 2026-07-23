/**
 * G3 citation (04-testing.md §5): every tool result carries a non-empty, valid
 * citation envelope — `tool_call_id` resolves in the DB, event refs resolve, and any
 * drilldown summary's args parse against the target tool's schema (C1–C3). The DB
 * lookups are injected via `CitationResolver`; the Agent-SDK runner (PR #15) wires a
 * real DB-backed resolver, keeping this grader pure and unit-testable.
 */
import { analyticsListEventsInput, type EventRef } from '@pet-crypto/core';

import type { GradeResult, Transcript } from '../transcript.js';

export interface CitationResolver {
  /** The persisted tool_call row exists (C1). */
  toolCallExists(toolCallId: string): boolean;
  /** The referenced chain_event exists (C3). */
  eventRefResolves(ref: EventRef): boolean;
}

export function gradeCitation(t: Transcript, resolver: CitationResolver): GradeResult {
  if (t.invocations.length === 0) {
    return { pass: false, detail: 'no tool invocations to cite' };
  }

  for (const inv of t.invocations) {
    const c = inv.envelope.citations;
    if (!c.tool_call_id) return { pass: false, detail: `${inv.name}: empty tool_call_id` };
    if (!resolver.toolCallExists(c.tool_call_id)) {
      return { pass: false, detail: `${inv.name}: tool_call_id ${c.tool_call_id} does not resolve` };
    }
    for (const ref of c.event_refs ?? []) {
      if (!resolver.eventRefResolves(ref)) {
        return { pass: false, detail: `${inv.name}: event ref ${ref.tx_hash}:${String(ref.log_index)} does not resolve` };
      }
    }
    const summary = c.event_ref_summary;
    if (summary) {
      const parsed = analyticsListEventsInput.safeParse(summary.drilldown.args);
      if (!parsed.success) {
        return { pass: false, detail: `${inv.name}: drilldown args do not parse against analytics_list_events` };
      }
      for (const ref of summary.sample) {
        if (!resolver.eventRefResolves(ref)) {
          return { pass: false, detail: `${inv.name}: drilldown sample ref does not resolve` };
        }
      }
    }
  }
  return { pass: true, detail: 'citations ok' };
}

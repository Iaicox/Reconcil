/**
 * The graded unit: one agent session for one eval case + run. The deterministic
 * graders (G1–G5, 04-testing.md §5) are pure functions over a `Transcript`; the
 * Agent-SDK runner (PR #15) produces real transcripts to feed them. Numbers are
 * canonicalised with core's exact bigint scaling (ADR-004) so G2 compares
 * decimal strings, never floats.
 */
import { formatUnits, parseUnits } from '@pet-crypto/core';
import type { ToolEnvelope } from '@pet-crypto/mcp-tools';

/** One tool call within a session: the tool, its args, and the returned citation envelope. */
export interface ToolInvocation {
  name: string;
  args: unknown;
  envelope: ToolEnvelope<unknown>;
}

/** A single graded agent session (one eval case, one run). */
export interface Transcript {
  invocations: ToolInvocation[];
  finalAnswer: string;
}

export interface GradeResult {
  pass: boolean;
  detail: string;
}

export const calledTools = (t: Transcript): string[] => t.invocations.map((i) => i.name);

/**
 * Canonical-minimal decimal form, or null if `raw` is not a decimal. Thousands
 * separators are dropped; the round-trip through core's exact bigint scaling trims
 * trailing fractional zeros, drops a bare point, and collapses `-0` → `0`.
 */
export function canonicalDecimal(raw: string): string | null {
  const cleaned = raw.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const dot = cleaned.indexOf('.');
  const decimals = dot === -1 ? 0 : cleaned.length - dot - 1;
  return formatUnits(parseUnits(cleaned, decimals), decimals);
}

/**
 * Decimal-number tokens in free text, canonicalised + deduped. The pattern is
 * bounded (no nested quantifier over an overlapping class), so it is ReDoS-safe.
 * Incidental digits inside hashes/addresses are a known over-match — tolerable
 * because both the answer and the tool results run through the same extraction.
 */
export function extractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const c = canonicalDecimal(m[0]);
    if (c !== null) out.add(c);
  }
  return out;
}

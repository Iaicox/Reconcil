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
 * Decimal-number tokens in free text, canonicalised + deduped. A leading `-` is a sign
 * only when not preceded by a digit or dot (the `(?<![\d.])` guard), so an ISO date
 * ("2026-06-30") yields 2026/6/30 rather than 2026/-6/-30, and a range ("1.5-2.5") does
 * not invent a negative. The pattern is bounded (the lookbehind is zero-width, no nested
 * quantifier over an overlapping class), so it is ReDoS-safe.
 *
 * Two acknowledged limitations, both weakening the check rather than breaking it:
 * incidental digits inside hashes/addresses over-match, and structural integers in tool
 * results (decimals: 18, chain_id: 1) enter the anti-fabrication "provided" set — so a
 * fabricated 18 or 1 can slip through (false negative). A magnitude/context-aware match
 * is a follow-up once the runner (PR #15) exercises this on real transcripts.
 */
export function extractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\d.])-?\d[\d,]*(?:\.\d+)?/g)) {
    const c = canonicalDecimal(m[0]);
    if (c !== null) out.add(c);
  }
  return out;
}

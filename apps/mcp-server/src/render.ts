import type { ToolEnvelope } from '@pet-crypto/mcp-tools';

/**
 * Short human-readable rendering of an envelope's `data` for MCP text content
 * (contract §2), returned alongside the machine-readable `structuredContent`.
 * Pure formatting: it never recomputes or reformats numbers (P1) — money stays
 * the exact DecimalString the tool produced. A compact provenance footer
 * (warnings + tool_call_id) keeps the citation visible without re-deriving it.
 */
export function renderEnvelope(env: ToolEnvelope<unknown>): string {
  const parts = [JSON.stringify(env.data, null, 2)];
  if (env.warnings.length > 0) {
    parts.push(`warnings: ${env.warnings.map((w) => w.code).join(', ')}`);
  }
  parts.push(`tool_call_id: ${env.citations.tool_call_id}`);
  return parts.join('\n\n');
}

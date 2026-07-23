import type { ToolEnvelope } from '@pet-crypto/mcp-tools';

/** Compact one-line shape of `data`: arrays as counts, nested objects elided, scalars verbatim. */
function summarizeData(data: unknown): string {
  if (data === null || typeof data !== 'object') return String(data);
  if (Array.isArray(data)) return `${data.length} items`;
  const parts = Object.entries(data as Record<string, unknown>).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: ${v.length}`;
    if (v !== null && typeof v === 'object') return `${k}: {…}`;
    return `${k}: ${String(v)}`;
  });
  return parts.length > 0 ? parts.join(', ') : '(empty)';
}

/**
 * Short human-readable rendering of an envelope for MCP text content (contract §2),
 * returned alongside the full machine-readable `structuredContent` (which carries
 * `data` in full — the text is a glanceable summary, not a second copy of the
 * payload). Pure formatting: scalar values (including money DecimalStrings) are
 * echoed verbatim, never recomputed or reformatted (P1). A provenance footer keeps
 * the citation visible without re-deriving it.
 */
export function renderEnvelope(env: ToolEnvelope<unknown>): string {
  const parts = [summarizeData(env.data)];
  if (env.warnings.length > 0) {
    parts.push(`warnings: ${env.warnings.map((w) => w.code).join(', ')}`);
  }
  parts.push(`tool_call_id: ${env.citations.tool_call_id}`);
  return parts.join('\n');
}

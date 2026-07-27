/**
 * Envelope assertions for the E2E compose smoke (compose-smoke.ts) — the
 * pre-release layer of the test pyramid (04-testing.md §1). Kept pure and
 * Docker-free so the smoke's pass/fail logic is unit-tested hermetically
 * (test/smoke-assert.test.ts); the script only wires these onto live tool results.
 *
 * A tool result is the MCP CallToolResult: `structuredContent` carries the
 * ToolEnvelope (envelope.ts), `isError` flags a tool-level failure. We check the
 * contract invariants any successful call must satisfy — provenance present (C1),
 * schema pinned (§2) — and hand back the narrowed envelope for per-tool assertions.
 */

/** The envelope fields the smoke asserts on, narrowed from `structuredContent`. */
export interface CheckedEnvelope {
  data: Record<string, unknown>;
  citations: { tool_call_id: string } & Record<string, unknown>;
  warnings: unknown[];
  meta: { schema_version: number; computed_at: string; units: string } & Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Assert a successful, contract-shaped envelope; throw (naming the tool) otherwise.
 * `res` is an MCP CallToolResult (typed as `unknown` — the SDK return is a broad union;
 * we narrow defensively). Returns the narrowed envelope for per-tool data assertions.
 */
export function assertEnvelope(toolName: string, res: unknown): CheckedEnvelope {
  const fail = (why: string): never => {
    throw new Error(`${toolName}: ${why}`);
  };

  if (!isRecord(res)) return fail('tool result is not an object');
  if (res['isError']) fail('tool returned isError');

  const sc = res['structuredContent'];
  if (!isRecord(sc)) return fail('missing structuredContent envelope');

  if (!isRecord(sc['data'])) fail('envelope.data is not an object');

  const citations = sc['citations'];
  if (!isRecord(citations)) return fail('envelope.citations is missing');
  const toolCallId = citations['tool_call_id'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    fail('citations.tool_call_id is missing or empty (C1 provenance)');
  }

  const meta = sc['meta'];
  if (!isRecord(meta)) return fail('envelope.meta is missing');
  if (meta['schema_version'] !== 1) fail(`meta.schema_version is not 1 (got ${String(meta['schema_version'])})`);
  if (meta['units'] !== 'decimal-string') fail(`meta.units is not "decimal-string" (got ${String(meta['units'])})`);

  return sc as unknown as CheckedEnvelope;
}

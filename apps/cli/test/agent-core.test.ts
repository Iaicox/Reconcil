import type { ToolInvocation } from '@pet-crypto/evals';
import { tools as toolRegistry, type ToolContext, type ToolEnvelope, type ToolHandler } from '@pet-crypto/mcp-tools';
import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, makeToolRun, toolSpecs } from '../src/agent/core.js';

// --- buildSystemPrompt ---------------------------------------------------------

describe('buildSystemPrompt', () => {
  it('interpolates the reference date so relative periods resolve against it', () => {
    expect(buildSystemPrompt('2026-07-17')).toContain("Today's date is 2026-07-17");
    expect(buildSystemPrompt('2020-01-01')).toContain("Today's date is 2020-01-01");
  });

  it('carries the guardrails and figure-verbatim rule the eval gate validates', () => {
    const p = buildSystemPrompt('2026-07-17');
    expect(p).toContain('investment advice');
    expect(p).toContain('tax advice');
    expect(p.toLowerCase()).toContain('predict'); // price-prediction refusal
    expect(p).toContain('EXACTLY'); // report figures verbatim, no rounding
    expect(p).toContain('untrusted'); // hostile-input isolation (P7)
  });
});

// --- makeToolRun ---------------------------------------------------------------

const ENVELOPE: ToolEnvelope<unknown> = {
  data: { balance: '1.5' },
  citations: { tool_call_id: 'tc-1', coverage: [] },
  warnings: [],
  meta: { schema_version: 1, computed_at: '2026-07-17T00:00:00.000Z', units: 'decimal-string' },
};

describe('makeToolRun', () => {
  it('runs the handler, notifies onInvocation, and returns only data/citations/warnings', async () => {
    const handler: ToolHandler = () => Promise.resolve(ENVELOPE);
    let captured: ToolInvocation | undefined;
    const run = makeToolRun(handler, {} as ToolContext, 'analytics_balances', (inv) => {
      captured = inv;
    });

    const out = await run({ scope: 'all' });

    expect(captured).toEqual({ name: 'analytics_balances', args: { scope: 'all' }, envelope: ENVELOPE });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).toEqual({ data: ENVELOPE.data, citations: ENVELOPE.citations, warnings: ENVELOPE.warnings });
    // meta stays server-side — the model never needs computed_at/schema_version.
    expect(parsed['meta']).toBeUndefined();
  });

  it('works without an onInvocation sink', async () => {
    const handler: ToolHandler = () => Promise.resolve(ENVELOPE);
    const run = makeToolRun(handler, {} as ToolContext, 'analytics_balances');
    await expect(run({})).resolves.toContain('"tool_call_id":"tc-1"');
  });
});

// --- toolSpecs -----------------------------------------------------------------

describe('toolSpecs', () => {
  it('produces one spec per registered tool, named + described, with a runnable handler', () => {
    const specs = toolSpecs({} as ToolContext);
    expect(specs.map((s) => s.name)).toEqual(toolRegistry.map((t) => t.name));
    for (const s of specs) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(typeof s.run).toBe('function');
      expect(s.inputSchema).toMatchObject({ type: 'object' });
    }
  });
});

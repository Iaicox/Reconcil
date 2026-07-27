import { describe, expect, it } from 'vitest';

import { assertEnvelope } from '../src/smoke-assert.js';

/**
 * Pure, Docker-free unit for the envelope assertion the compose smoke leans on
 * (compose-smoke.ts). The E2E script can only be exercised against a live
 * `docker compose` stack; this pins the *shape* checks hermetically so the smoke's
 * pass/fail logic itself is covered and can red-green in the normal `test` job.
 */
const wellFormed = {
  isError: false,
  structuredContent: {
    data: { wallets: [] },
    citations: { tool_call_id: 'tc_abc', coverage: [] },
    warnings: [],
    meta: { schema_version: 1, computed_at: '2026-07-27T00:00:00.000Z', units: 'decimal-string' },
  },
};

describe('assertEnvelope', () => {
  it('accepts a well-formed tool result and returns the narrowed envelope', () => {
    const env = assertEnvelope('ledger_status', wellFormed);
    expect(env.citations.tool_call_id).toBe('tc_abc');
    expect(env.meta.schema_version).toBe(1);
  });

  it('throws (naming the tool) when the result is an MCP error', () => {
    expect(() =>
      assertEnvelope('ledger_status', { isError: true, structuredContent: { code: 'INTERNAL' } }),
    ).toThrow(/ledger_status/);
  });

  it('throws when citations.tool_call_id is missing (C1 provenance)', () => {
    const bad = {
      isError: false,
      structuredContent: { ...wellFormed.structuredContent, citations: { coverage: [] } },
    };
    expect(() => assertEnvelope('recon_status', bad)).toThrow(/tool_call_id/);
  });

  it('throws when meta.schema_version is not 1', () => {
    const bad = {
      isError: false,
      structuredContent: {
        ...wellFormed.structuredContent,
        meta: { schema_version: 2, computed_at: 'x', units: 'decimal-string' },
      },
    };
    expect(() => assertEnvelope('ledger_status', bad)).toThrow(/schema_version/);
  });

  it('throws when structuredContent is absent entirely', () => {
    expect(() => assertEnvelope('ledger_status', { isError: false })).toThrow(/ledger_status/);
  });
});

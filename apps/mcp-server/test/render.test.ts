import type { ToolEnvelope } from '@pet-crypto/mcp-tools';
import { describe, expect, it } from 'vitest';

import { renderEnvelope } from '../src/render.js';

function makeEnvelope(
  data: unknown,
  warnings: ToolEnvelope<unknown>['warnings'] = [],
): ToolEnvelope<unknown> {
  return {
    data,
    citations: { tool_call_id: 'call_123', coverage: [] },
    warnings,
    meta: { schema_version: 1, computed_at: '2026-07-23T00:00:00Z', units: 'decimal-string' },
  };
}

describe('renderEnvelope', () => {
  it('renders data and a tool_call_id footer, no warnings line when clean', () => {
    const text = renderEnvelope(makeEnvelope({ total: '100.50' }));
    expect(text).toContain('"total": "100.50"');
    expect(text).toContain('tool_call_id: call_123');
    expect(text).not.toContain('warnings:');
  });

  it('lists warning codes when present', () => {
    const text = renderEnvelope(makeEnvelope({ x: 1 }, [{ code: 'PRICE_MISSING', message: 'no snapshot' }]));
    expect(text).toContain('warnings: PRICE_MISSING');
  });

  it('preserves money as the exact DecimalString — no float reformat (P1)', () => {
    const text = renderEnvelope(makeEnvelope({ amount: '0.000000000000000001' }));
    expect(text).toContain('0.000000000000000001');
  });
});

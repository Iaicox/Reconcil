import { describe, expect, it } from 'vitest';

import { buildEnvelope } from '../src/envelope.js';
import { canonicalStringify } from '../src/tool-calls.js';
import { ulid } from '../src/ulid.js';

describe('buildEnvelope', () => {
  it('assembles citations + meta and omits empty price/fx refs', () => {
    const env = buildEnvelope({ ok: true }, {
      toolCallId: 'TC1',
      coverage: [],
      priceRefs: [],
      fxRefs: [],
      warnings: [{ code: 'DATA_STALE', message: 'x' }],
    });
    expect(env.data).toEqual({ ok: true });
    expect(env.citations.tool_call_id).toBe('TC1');
    expect(env.citations.price_refs).toBeUndefined(); // empty → omitted
    expect(env.citations.fx_refs).toBeUndefined();
    expect(env.meta).toMatchObject({ schema_version: 1, units: 'decimal-string' });
    expect(env.warnings).toHaveLength(1);
  });
});

describe('ulid', () => {
  it('is 26 Crockford-base32 chars and sorts by time', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const earlier = ulid(1000);
    const later = ulid(2000);
    expect(earlier < later).toBe(true); // lexical order follows time
  });
});

describe('canonicalStringify', () => {
  it('is key-order independent and drops undefined', () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
    expect(canonicalStringify({ a: 1, b: undefined })).toBe(canonicalStringify({ a: 1 }));
  });

  it('is stable across nesting and arrays', () => {
    const x = canonicalStringify({ list: [{ z: 1, a: 2 }], n: 'k' });
    const y = canonicalStringify({ n: 'k', list: [{ a: 2, z: 1 }] });
    expect(x).toBe(y);
  });
});

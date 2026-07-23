import { describe, expect, it } from 'vitest';

import { parseBearerToken } from '../src/auth.js';

describe('parseBearerToken', () => {
  it('extracts the token, matching the scheme case-insensitively (RFC 7235)', () => {
    expect(parseBearerToken('Bearer abc123')).toBe('abc123');
    expect(parseBearerToken('bearer abc123')).toBe('abc123');
    expect(parseBearerToken('BEARER abc123')).toBe('abc123');
  });

  it('returns null for absent, non-Bearer, or empty credentials', () => {
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken('Basic abc123')).toBeNull();
    expect(parseBearerToken('Bearer')).toBeNull();
    expect(parseBearerToken('Bearer ')).toBeNull();
  });
});

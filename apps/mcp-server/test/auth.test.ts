import { describe, expect, it } from 'vitest';

import { parseBearerToken } from '../src/auth.js';
import { parseKeygenArgs } from '../src/keygen.js';

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

describe('parseKeygenArgs', () => {
  it('reads the positionals, with no expiry unless asked', () => {
    expect(parseKeygenArgs(['acme'])).toEqual({ slug: 'acme' });
    expect(parseKeygenArgs(['acme', 'ci-key'])).toEqual({ slug: 'acme', label: 'ci-key' });
  });

  it('accepts --expires-in-days before or after the positionals', () => {
    expect(parseKeygenArgs(['acme', 'ci-key', '--expires-in-days', '30']))
      .toEqual({ slug: 'acme', label: 'ci-key', expiresInDays: 30 });
    expect(parseKeygenArgs(['--expires-in-days', '7', 'acme']))
      .toEqual({ slug: 'acme', expiresInDays: 7 });
  });

  it('throws on a missing or non-numeric lifetime instead of minting a non-expiring key', () => {
    // Silently ignoring it would hand back a key that never expires while the operator
    // believes it does — the one outcome worse than an error.
    expect(() => parseKeygenArgs(['acme', '--expires-in-days'])).toThrow(/needs a number/);
    expect(() => parseKeygenArgs(['acme', '--expires-in-days', 'soon'])).toThrow(/needs a number/);
  });
});

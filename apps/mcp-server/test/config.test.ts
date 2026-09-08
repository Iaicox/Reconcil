import { describe, expect, it } from 'vitest';

import { loadConfig, resolveAllowedHosts, resolveTrustProxy } from '../src/config.js';

describe('resolveTrustProxy', () => {
  it('is OFF when unset or blank — request.ip stays the socket peer', () => {
    // The default matters more than any other case here: with it on, any client can name
    // its own IP in X-Forwarded-For and step out of the per-IP backstop entirely.
    expect(resolveTrustProxy({})).toBeUndefined();
    expect(resolveTrustProxy({ RECONCIL_TRUST_PROXY: '' })).toBeUndefined();
    expect(resolveTrustProxy({ RECONCIL_TRUST_PROXY: '   ' })).toBeUndefined();
  });

  it('reads the two booleans, and does not treat "false" as a non-empty truthy string', () => {
    expect(resolveTrustProxy({ RECONCIL_TRUST_PROXY: 'true' })).toBe(true);
    expect(resolveTrustProxy({ RECONCIL_TRUST_PROXY: 'false' })).toBe(false);
  });

  it('passes an IP/CIDR list through for proxy-addr to parse', () => {
    expect(resolveTrustProxy({ RECONCIL_TRUST_PROXY: '127.0.0.1' })).toBe('127.0.0.1');
    expect(resolveTrustProxy({ RECONCIL_TRUST_PROXY: '10.0.0.0/8, 192.168.0.0/16' }))
      .toBe('10.0.0.0/8, 192.168.0.0/16');
  });
});

describe('loadConfig — RECONCIL_TRUST_PROXY validation', () => {
  const base = { DATABASE_URL: 'postgres://x' };

  it('accepts the booleans, an IP/CIDR list, and proxy-addr\'s named ranges', () => {
    for (const v of ['true', 'false', '127.0.0.1', '10.0.0.0/8, 192.168.0.0/16', 'loopback', '::1']) {
      expect(loadConfig({ ...base, RECONCIL_TRUST_PROXY: v }).RECONCIL_TRUST_PROXY).toBe(v);
    }
  });

  it('rejects a typo by NAME, instead of letting Fastify die at boot', () => {
    // proxy-addr.compile throws `unsupported trust argument` from inside the Fastify
    // constructor, so the process would exit 1 with a serialized TypeError that never
    // mentions the variable. Every other env here is validated; this one is too.
    for (const v of ['yes', 'True', '1', 'not-an-ip']) {
      expect(() => loadConfig({ ...base, RECONCIL_TRUST_PROXY: v })).toThrow(/RECONCIL_TRUST_PROXY/);
    }
  });
});

describe('resolveAllowedHosts', () => {
  it('derives the three deployment forms from PORT when unset', () => {
    expect(resolveAllowedHosts({ PORT: 8484 })).toEqual([
      'localhost:8484', '127.0.0.1:8484', 'mcp-server:8484',
    ]);
  });

  it('takes an explicit comma-separated override, trimmed', () => {
    expect(resolveAllowedHosts({ PORT: 8484, RECONCIL_ALLOWED_HOSTS: 'a.example:443, b.example:443' }))
      .toEqual(['a.example:443', 'b.example:443']);
  });

  it('falls back to the derived list when the override is empty or only separators', () => {
    expect(resolveAllowedHosts({ PORT: 1234, RECONCIL_ALLOWED_HOSTS: ' , , ' }))
      .toEqual(['localhost:1234', '127.0.0.1:1234', 'mcp-server:1234']);
  });
});

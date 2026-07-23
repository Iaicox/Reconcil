import type { Logger } from '@pet-crypto/core';
import type { Db } from '@pet-crypto/db';
import { describe, expect, it } from 'vitest';

import { buildHttpApp } from '../src/http.js';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** db is unused on the health/401 paths (auth is injected), so a stub is safe. */
function appWith(authenticate: (h: string | undefined) => Promise<string | null>) {
  return buildHttpApp({ db: {} as unknown as Db, logger: silentLogger, authenticate });
}

const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' } as const;

describe('buildHttpApp — health + bearer gate (hermetic, via inject)', () => {
  it('GET /healthz returns ok', async () => {
    const app = appWith(() => Promise.resolve(null));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('POST /mcp without a bearer → 401 + WWW-Authenticate, no domain detail', async () => {
    const app = appWith(() => Promise.resolve(null));
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: rpc,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json()).toEqual({ error: 'unauthorized' });
    await app.close();
  });

  it('POST /mcp with an unrecognized bearer → 401', async () => {
    const app = appWith((h) => Promise.resolve(h === 'Bearer good' ? 'tenant-1' : null));
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bad' },
      payload: rpc,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

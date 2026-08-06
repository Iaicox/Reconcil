import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger } from '@reconcil/core';
import type { Db } from '@reconcil/db';
import { describe, expect, it, vi } from 'vitest';

import { buildHttpApp, handleHijackedTransport } from '../src/http.js';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** db is unused on the health/401 paths (auth is injected), so a stub is safe. */
function appWith(authenticate: (h: string | undefined) => Promise<string | null>) {
  return buildHttpApp({ db: {} as unknown as Db, logger: silentLogger, authenticate });
}

const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' } as const;

describe('buildHttpApp — health + bearer gate (hermetic, via inject)', () => {
  it('GET /healthz returns ok and is not rate-limited', async () => {
    const app = await appWith(() => Promise.resolve(null));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    await app.close();
  });

  it('POST /mcp without a bearer → 401 + WWW-Authenticate, no domain detail, rate-limited', async () => {
    const app = await appWith(() => Promise.resolve(null));
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: rpc,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json()).toEqual({ error: 'unauthorized' });
    // rate limit is active on /mcp (CodeQL js/missing-rate-limiting)
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    await app.close();
  });

  it('POST /mcp with an unrecognized bearer → 401', async () => {
    const app = await appWith((h) => Promise.resolve(h === 'Bearer good' ? 'tenant-1' : null));
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

/** Minimal fake ServerResponse: only the members handleHijackedTransport touches. */
function fakeRes(headersSent: boolean): {
  res: ServerResponse;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  const writeHead = vi.fn();
  const end = vi.fn();
  const destroy = vi.fn();
  return { res: { headersSent, writeHead, end, destroy } as unknown as ServerResponse, writeHead, end, destroy };
}

const fakeReq = {} as unknown as IncomingMessage;

describe('handleHijackedTransport — H14 error path after hijack', () => {
  it('no hang: rejection before any bytes were written → logs + bare static 500, socket not destroyed', async () => {
    const errors: unknown[] = [];
    const logger: Logger = { info: () => {}, warn: () => {}, error: (msg, fields) => { errors.push({ msg, fields }); } };
    const { res, writeHead, end, destroy } = fakeRes(false);
    const transport = { handleRequest: () => Promise.reject(new Error('boom')) };

    await handleHijackedTransport(transport, fakeReq, res, undefined, logger);

    expect(writeHead).toHaveBeenCalledWith(500, { 'content-type': 'application/json' });
    expect(end).toHaveBeenCalledWith(JSON.stringify({ error: 'internal_error' }));
    expect(destroy).not.toHaveBeenCalled();
    // logged via serializeError, not the raw thrown value/message text (§4/ADR-011)
    expect(errors).toHaveLength(1);
    expect(errors).toEqual([expect.objectContaining({ msg: expect.stringContaining('handleRequest failed') })]);
  });

  it('no hang: rejection after headers already sent → destroy() the socket, no double-write', async () => {
    const { res, writeHead, end, destroy } = fakeRes(true);
    const transport = { handleRequest: () => Promise.reject(new Error('boom after headers')) };

    await handleHijackedTransport(transport, fakeReq, res, undefined, silentLogger);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it('a resolving handleRequest is a no-op (nothing extra written)', async () => {
    const { res, writeHead, end, destroy } = fakeRes(false);
    const transport = { handleRequest: () => Promise.resolve() };

    await handleHijackedTransport(transport, fakeReq, res, undefined, silentLogger);

    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe('buildHttpApp — DNS-rebinding Host validation (minor, defense-in-depth)', () => {
  function appWithHosts(allowedHosts: string[]) {
    return buildHttpApp({
      db: {} as unknown as Db,
      logger: silentLogger,
      authenticate: () => Promise.resolve('tenant-1'),
      allowedHosts,
    });
  }

  it('mismatched Host header is rejected before reaching protocol logic', async () => {
    const app = await appWithHosts(['good.example:8484']);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good', host: 'evil.example:8484' },
      payload: rpc,
    });
    // Whatever status the SDK emits for an invalid Host (currently 403; asserted
    // loosely on the reason so a future SDK bump that changes the code doesn't
    // silently stop testing the right thing).
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = res.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain('Invalid Host header');
    await app.close();
  });

  it('matching Host header passes validation — full round trip through hijack + real transport', async () => {
    const app = await appWithHosts(['good.example:8484']);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer good',
        host: 'good.example:8484',
      },
      payload: rpc,
    });
    // Stateless mode (sessionIdGenerator omitted) skips session validation entirely,
    // so a passing Host check runs the tools/list call for real all the way through
    // reply.hijack() — the strongest possible proof the Host check let it through:
    // a real SSE-streamed JSON-RPC result, not just "didn't 403".
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).not.toContain('Invalid Host header');
    const dataLine = res.body.split('\n').find((l) => l.startsWith('data: '));
    const payload = JSON.parse((dataLine ?? '').slice('data: '.length)) as { result?: { tools?: unknown[] } };
    expect(payload.result?.tools?.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe('buildHttpApp — rate-limit key = presented bearer token hash (minor)', () => {
  it('two different bearer tokens from the same IP get independent buckets', async () => {
    const app = await buildHttpApp({
      db: {} as unknown as Db,
      logger: silentLogger,
      authenticate: () => Promise.resolve(null), // irrelevant here: the limiter keys on the raw token, pre-auth
      rateLimit: { max: 1, timeWindow: '1 minute' },
    });
    const withToken = (token: string) => app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: rpc,
    });

    const a1 = await withToken('token-a');
    expect(a1.statusCode).toBe(401); // consumes token-a's one-request allowance
    const a2 = await withToken('token-a');
    expect(a2.statusCode).toBe(429); // same key → limit exceeded

    const b1 = await withToken('token-b');
    expect(b1.statusCode).toBe(401); // independent bucket — not exhausted by token-a's traffic
    await app.close();
  });

  it('unauthenticated requests are keyed by IP — the 401 they draw still counts against that bucket', async () => {
    const app = await buildHttpApp({
      db: {} as unknown as Db,
      logger: silentLogger,
      authenticate: () => Promise.resolve(null),
      rateLimit: { max: 1, timeWindow: '1 minute' },
    });
    const noAuth = () => app.inject({
      method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: rpc,
    });

    const r1 = await noAuth();
    expect(r1.statusCode).toBe(401);
    const r2 = await noAuth();
    expect(r2.statusCode).toBe(429); // r1's 401 already consumed the IP bucket's allowance
    await app.close();
  });
});

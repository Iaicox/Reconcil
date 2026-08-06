import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, serializeError, type Logger } from '@reconcil/core';
import { createDb, type Db } from '@reconcil/db';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Pool } from 'pg';

import { parseBearerToken, resolveTenantByBearer } from './auth.js';
import { DEFAULT_PORT, loadConfig, resolveAllowedHosts } from './config.js';
import { createServer } from './server.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the /mcp preHandler once bearer auth succeeds (§3 restructure). Layer
     * 1's IP-keyed rate limit runs at the earlier `onRequest` hook and never reads
     * this; layer 2's tenant-keyed fairness bucket runs from inside the preHandler,
     * immediately after this is set, and does depend on it (see `tenantRateLimitKey`).
     */
    tenantId?: string;
  }
}

/** `Authorization: Bearer <key>` → tenant, or null (absent/unknown/revoked → 401). */
async function bearerTenant(db: Db, header: string | undefined): Promise<string | null> {
  const token = parseBearerToken(header);
  if (token === null) return null;
  return resolveTenantByBearer(db, token);
}

/**
 * Two-layer rate limiting (fix for a Critical review finding: keying the single
 * former layer on the *presented* token's hash let an attacker rotate a fresh
 * garbage `Authorization: Bearer <garbage-N>` per request and land in a brand-new
 * bucket every time — the 429 never tripped, and every request still reached
 * authPreHandler's live `resolveTenantByBearer` DB SELECT: unbounded 401 + DB-query
 * amplification per IP, strictly weaker than the plain per-IP default this replaced).
 *
 * Layer 1 — IP backstop (`ipRateLimitKey`, below): the automatic per-route hook, at
 * the plugin's default `onRequest` stage — before the auth preHandler runs, before
 * any DB work. Keyed on `request.ip` alone, so no Authorization header value (valid,
 * invalid, or absent) changes which bucket a request lands in. Generous ceiling
 * (600/min default) so it doesn't punish a legitimately busy tenant; it exists only
 * to cap the *worst case* per source, and nothing short of a new source IP escapes it.
 *
 * Layer 2 — tenant fairness bucket (`tenantRateLimitKey` + `checkTenantRateLimit`,
 * used from `authPreHandler`): only reached once `authenticate()` has resolved a
 * REAL tenant from a DB-verified key — an attacker with no valid key never occupies
 * or exhausts this bucket, however many requests they send. Built via
 * `@fastify/rate-limit`'s own `createRateLimit` escape hatch (its documented way to
 * run a check outside the automatic per-route hook, so it can run mid-preHandler
 * after auth instead of only at onRequest) with its own store/bucket namespace, kept
 * at the original 120/min fairness policy.
 */
function ipRateLimitKey(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

/** Only ever read after authPreHandler has just set `request.tenantId` from a
 * DB-verified key — never from an unvalidated presented token. */
function tenantRateLimitKey(request: FastifyRequest): string {
  return `tenant:${request.tenantId ?? 'unresolved'}`;
}

/** Return type of `@fastify/rate-limit`'s `createRateLimit(options)` factory
 * (types/index.d.ts) — a standalone checker callable outside the automatic
 * per-route hook, used here from inside authPreHandler for layer 2. */
type TenantRateLimiter = ReturnType<FastifyInstance['createRateLimit']>;

const UNAUTHORIZED_BODY = { error: 'unauthorized' } as const;
const RATE_LIMITED_BODY = { error: 'rate_limited' } as const;

/** Fastify preHandler: resolves the bearer tenant and stores it on `request`, then
 * applies the layer-2 tenant fairness bucket (only reachable with a resolved
 * tenant — see the block comment above); answers 401/429 and short-circuits the
 * route on failure (Fastify does not call the handler once a preHandler has sent a
 * reply). Auth extracted from the route so layer 1's keyGenerator can run first
 * without waiting on this. */
function authPreHandler(
  authenticate: (authorization: string | undefined) => Promise<string | null>,
  checkTenantRateLimit: TenantRateLimiter,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const tenantId = await authenticate(request.headers.authorization);
    if (tenantId === null) {
      // Transport-level auth failure: no domain detail (§4); advertise the scheme (RFC 7235).
      await reply.code(401).header('WWW-Authenticate', 'Bearer').send(UNAUTHORIZED_BODY);
      return;
    }
    request.tenantId = tenantId;

    // `checkTenantRateLimit`'s `isAllowed` flag is misleading by itself: per the
    // plugin's own applyRateLimit (index.js), it is `true` ONLY on the allowList
    // bypass path (unused here) and unconditionally `false` on every normal
    // counted call — the actual "is this request over budget" signal is
    // `isExceeded` (current > max), which is only present on that `false` branch.
    // This mirrors the plugin's own automatic-hook logic (rateLimitRequestHandler):
    // isAllowed → let through; else look at isExceeded before deciding to block.
    const limit = await checkTenantRateLimit(request);
    if (!limit.isAllowed && limit.isExceeded) {
      await reply
        .code(429)
        .header('x-ratelimit-limit', limit.max)
        .header('x-ratelimit-remaining', limit.remaining)
        .header('x-ratelimit-reset', limit.ttlInSeconds)
        .header('retry-after', limit.ttlInSeconds)
        .send(RATE_LIMITED_BODY);
    }
  };
}

const INTERNAL_ERROR_BODY = JSON.stringify({ error: 'internal_error' });

/**
 * H14: after `reply.hijack()` Fastify can no longer answer for this request — an
 * unhandled rejection out of the SDK transport would otherwise leave the socket
 * open with no status and no timeout. Catch it, log via the existing logger
 * (serializeError — never raw provider/SDK text, ADR-011), then answer directly
 * on the raw response: a bare static 500 if nothing was written yet, or
 * `destroy()` the socket if headers already went out (a started response can't
 * be retracted). Either branch resolves — no hang. Takes only `handleRequest` so
 * tests can inject a failing stub transport without opening a real socket.
 */
export async function handleHijackedTransport(
  transport: Pick<StreamableHTTPServerTransport, 'handleRequest'>,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  logger: Logger,
): Promise<void> {
  try {
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    logger.error('mcp transport handleRequest failed after hijack', { err: serializeError(err) });
    if (res.headersSent) {
      res.destroy();
    } else {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(INTERNAL_ERROR_BODY);
    }
  }
}

export interface HttpDeps {
  db: Db;
  logger: Logger;
  /** Resolve a request's Authorization header to a tenant id (null → 401). Injectable for tests. */
  authenticate?: (authorization: string | undefined) => Promise<string | null>;
  /** Host header allow-list for the transport's DNS-rebinding protection (minor,
   * defense-in-depth on top of bearer auth). Defaults to the localhost/127.0.0.1/
   * compose-service-name forms at DEFAULT_PORT — production always passes the
   * real one via config.ts `resolveAllowedHosts(cfg)`. */
  allowedHosts?: string[];
  /** Layer 1: IP-keyed hard ceiling on every /mcp request (valid credential, invalid,
   * or absent — see the block comment above `ipRateLimitKey`). Defaults to the
   * production 600/min. Overridable so tests can trip it deterministically. */
  ipRateLimit?: { max: number; timeWindow: string };
  /** Layer 2: per-authenticated-tenant fairness bucket, only reachable with a
   * DB-verified key (see `tenantRateLimitKey`). Defaults to the production 120/min
   * (the original single-layer policy). Overridable for tests. */
  tenantRateLimit?: { max: number; timeWindow: string };
}

/**
 * Minimal Fastify host (ADR-003): the entire HTTP surface is /mcp and /healthz.
 * No REST in the MVP; product logic has zero HTTP coupling. /mcp mounts the SDK's
 * streamable HTTP transport in stateless JSON-RPC mode (ADR-012) — one server +
 * transport per request, so tenants never share session state. Returned as a
 * factory so tests can drive it via `app.inject` without binding a socket.
 */
export async function buildHttpApp(deps: HttpDeps): Promise<FastifyInstance> {
  const { db, logger } = deps;
  const authenticate = deps.authenticate ?? ((h) => bearerTenant(db, h));
  const allowedHosts = deps.allowedHosts ?? resolveAllowedHosts({ PORT: DEFAULT_PORT });
  const ipRateLimitPolicy = deps.ipRateLimit ?? { max: 600, timeWindow: '1 minute' };
  const tenantRateLimitPolicy = deps.tenantRateLimit ?? { max: 120, timeWindow: '1 minute' };
  const app = Fastify({ logger: true });

  // Rate-limit the authenticated /mcp route (in-memory; CodeQL js/missing-rate-limiting).
  // global:false → only opted-in routes are limited, so /healthz stays unlimited. Awaited
  // before the route is defined so the plugin's onRoute hook sees its per-route config,
  // and so createRateLimit (layer 2, below) is available to decorate off of.
  await app.register(rateLimit, { global: false });

  // Layer 2's standalone checker (block comment above authPreHandler) — its own
  // bucket namespace via createRateLimit's `.child(...)` store, independent of
  // layer 1's per-route store below.
  const checkTenantRateLimit = app.createRateLimit({
    max: tenantRateLimitPolicy.max,
    timeWindow: tenantRateLimitPolicy.timeWindow,
    keyGenerator: tenantRateLimitKey,
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.all('/mcp', {
    // Layer 1 (IP backstop): the automatic per-route hook, at the plugin's default
    // onRequest stage — runs before the preHandler below, before any DB work.
    config: { rateLimit: { ...ipRateLimitPolicy, keyGenerator: ipRateLimitKey } },
    preHandler: authPreHandler(authenticate, checkTenantRateLimit),
  }, async (request, reply) => {
    const { tenantId } = request;
    if (tenantId === undefined) {
      // Unreachable in practice: authPreHandler above always either sets tenantId
      // or already answered 401 and short-circuited the route. Kept because the
      // module-augmented field is typed optional (Fastify can't express "always
      // set once preHandler passes") — a real regression here still 401s instead
      // of falling through with an undefined tenant.
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send(UNAUTHORIZED_BODY);
    }

    // Stateless mode: sessionIdGenerator omitted (our exactOptionalPropertyTypes
    // config forbids passing it as `undefined`; omission is equivalent at runtime).
    const transport = new StreamableHTTPServerTransport({
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    const server = createServer(() => ({ db, tenantId }), logger);
    reply.raw.on('close', () => {
      // void: fire-and-forget teardown; .catch keeps a rejected close off the
      // unhandledRejection path (void alone doesn't handle rejections).
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });

    // StreamableHTTPServerTransport implements Transport, but its getter-typed
    // onclose (`(() => void) | undefined`) trips exactOptionalPropertyTypes against
    // Transport's `onclose?: () => void`. It satisfies the interface at runtime.
    await server.connect(transport as unknown as Transport);
    reply.hijack(); // we own reply.raw from here; Fastify must not also respond
    await handleHijackedTransport(transport, request.raw, reply.raw, request.body, logger);
    return reply;
  });

  return app;
}

async function main(): Promise<void> {
  const logger = createLogger({ name: 'mcp-server:http' });
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  // An idle pooled client that errors (a Postgres restart/shutdown → FATAL 57P01)
  // emits 'error' on the Pool; with no listener Node throws it as unhandled and
  // crashes the process (dumping the raw cause, ADR-011). Route it to the logger.
  pool.on('error', (err) => { logger.error('postgres pool error', { err: serializeError(err) }); });
  const db = createDb(pool);
  const app = await buildHttpApp({ db, logger, allowedHosts: resolveAllowedHosts(cfg) });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await pool.end();
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => { void shutdown().catch(() => {}).finally(() => { process.exit(0); }); });
  }

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  logger.info('mcp-server http ready', { port: cfg.PORT });
}

// Start only when run directly (node dist/http.js) — importing this module for
// buildHttpApp in tests must not boot a server (mirrors seed.ts/keygen.ts).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    createLogger({ name: 'mcp-server:http' }).error('mcp-server http failed to start', { err: serializeError(err) });
    process.exit(1);
  });
}

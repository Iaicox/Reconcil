import { pathToFileURL } from 'node:url';

import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, serializeError, type Logger } from '@pet-crypto/core';
import { createDb, type Db } from '@pet-crypto/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { parseBearerToken, resolveTenantByBearer } from './auth.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

/** `Authorization: Bearer <key>` → tenant, or null (absent/unknown/revoked → 401). */
async function bearerTenant(db: Db, header: string | undefined): Promise<string | null> {
  const token = parseBearerToken(header);
  if (token === null) return null;
  return resolveTenantByBearer(db, token);
}

export interface HttpDeps {
  db: Db;
  logger: Logger;
  /** Resolve a request's Authorization header to a tenant id (null → 401). Injectable for tests. */
  authenticate?: (authorization: string | undefined) => Promise<string | null>;
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
  const app = Fastify({ logger: true });

  // Rate-limit the authenticated /mcp route (in-memory; CodeQL js/missing-rate-limiting).
  // global:false → only opted-in routes are limited, so /healthz stays unlimited. Awaited
  // before the route is defined so the plugin's onRoute hook sees its per-route config.
  await app.register(rateLimit, { global: false });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.all('/mcp', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const tenantId = await authenticate(request.headers.authorization);
    if (tenantId === null) {
      // Transport-level auth failure: no domain detail (§4); advertise the scheme (RFC 7235).
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'unauthorized' });
    }

    // Stateless mode: sessionIdGenerator omitted (our exactOptionalPropertyTypes
    // config forbids passing it as `undefined`; omission is equivalent at runtime).
    const transport = new StreamableHTTPServerTransport({});
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
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  });

  return app;
}

async function main(): Promise<void> {
  const logger = createLogger({ name: 'mcp-server:http' });
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  const db = createDb(pool);
  const app = await buildHttpApp({ db, logger });

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

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger, serializeError } from '@pet-crypto/core';
import { createDb, type Db } from '@pet-crypto/db';
import Fastify from 'fastify';
import { Pool } from 'pg';

import { resolveTenantByBearer } from './auth.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

/**
 * Minimal Fastify host (ADR-003): the entire HTTP surface is /mcp and /healthz.
 * No REST in the MVP; product logic has zero HTTP coupling. /mcp mounts the SDK's
 * streamable HTTP transport in stateless JSON-RPC mode (ADR-012) — one server +
 * transport per request, so tenants never share session state.
 */
const logger = createLogger({ name: 'mcp-server:http' });

/** `Authorization: Bearer <key>` → tenant, or null (unknown/revoked/absent → 401). */
async function bearerTenant(db: Db, header: string | undefined): Promise<string | null> {
  if (header === undefined) return null;
  const key = /^Bearer (.+)$/.exec(header)?.[1];
  if (key === undefined) return null;
  return resolveTenantByBearer(db, key);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  const db = createDb(pool);

  const app = Fastify({ logger: true });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.all('/mcp', async (request, reply) => {
    const tenantId = await bearerTenant(db, request.headers.authorization);
    if (tenantId === null) {
      // Transport-level auth failure carries no domain detail (contract §4).
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Stateless mode: sessionIdGenerator omitted (our exactOptionalPropertyTypes
    // config forbids passing it as `undefined`; omission is equivalent at runtime).
    const transport = new StreamableHTTPServerTransport({});
    const server = createServer(() => ({ db, tenantId }), logger);
    reply.raw.on('close', () => { void transport.close(); void server.close(); });

    // StreamableHTTPServerTransport implements Transport, but its getter-typed
    // onclose (`(() => void) | undefined`) trips exactOptionalPropertyTypes against
    // Transport's `onclose?: () => void`. It satisfies the interface at runtime.
    await server.connect(transport as unknown as Transport);
    reply.hijack(); // we own reply.raw from here; Fastify must not also respond
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await pool.end();
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => { void shutdown().finally(() => { process.exit(0); }); });
  }

  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  logger.error('mcp-server http failed to start', { err: serializeError(err) });
  process.exit(1);
});

import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeError } from '@reconcil/core';
import { createDb, ensureSelfHostTenant } from '@reconcil/db';
import { Pool } from 'pg';

import { loadConfig } from './config.js';
import { createStderrLogger } from './logger.js';
import { createServer } from './server.js';

/**
 * stdio entrypoint — the self-host default for Claude Desktop/Code (ADR-012).
 * Auth: none (process trust); the tenant is the single self-host tenant, resolved
 * and created-on-first-run from config, then fixed for every tool call.
 *
 * stdout carries the JSON-RPC protocol, so logs go to stderr (createStderrLogger)
 * — a stray stdout log line would corrupt the stream.
 */
const logger = createStderrLogger('mcp-server:stdio');

/** Worker's shutdown timeout (apps/worker/src/main.ts) — same grace period. */
const FORCE_EXIT_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  // An idle pooled client that errors (a Postgres restart/shutdown → FATAL 57P01) emits
  // 'error' on the Pool; with no listener Node throws it unhandled and crashes the process.
  // Logs go to stderr here (stdout is the JSON-RPC stream) — route it through the logger.
  pool.on('error', (err) => { logger.error('postgres pool error', { err: serializeError(err) }); });

  const db = createDb(pool);
  const tenantId = await ensureSelfHostTenant(db, cfg.SELF_HOST_TENANT_SLUG, cfg.SELF_HOST_TENANT_NAME);
  const server = createServer(() => ({ db, tenantId }), logger);
  await server.connect(new StdioServerTransport());
  logger.info('mcp-server stdio ready', { tenant: cfg.SELF_HOST_TENANT_SLUG });

  // Shutdown parity with apps/worker/src/main.ts: idempotent flag, close the MCP
  // server/transport (Protocol.close() cascades to transport.close()) before the
  // pg pool so no in-flight tool call is severed mid-transaction, a forced-exit
  // timer in case a close() hangs, and handlers registered only now that `server`
  // exists (the bug: previously they closed only the pool, `server` undefined).
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // ignore a second SIGINT/SIGTERM
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => { logger.error('shutdown timed out; forcing exit'); process.exit(1); }, FORCE_EXIT_TIMEOUT_MS);
    force.unref();
    try {
      await server.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      logger.error('shutdown error', { err: serializeError(err) });
      process.exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void shutdown(signal); });
  }
}

// Start only when run directly (node dist/stdio.js) — importing this module in a
// test must not boot a real server + pg pool (mirrors http.ts/keygen.ts).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    logger.error('mcp-server stdio failed to start', { err: serializeError(err) });
    process.exit(1);
  });
}

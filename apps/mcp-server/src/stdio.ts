import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeError } from '@pet-crypto/core';
import { createDb } from '@pet-crypto/db';
import { Pool } from 'pg';

import { ensureSelfHostTenant } from './auth.js';
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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => { void pool.end().catch(() => {}).finally(() => { process.exit(0); }); });
  }

  const db = createDb(pool);
  const tenantId = await ensureSelfHostTenant(db, cfg.SELF_HOST_TENANT_SLUG, cfg.SELF_HOST_TENANT_NAME);
  const server = createServer(() => ({ db, tenantId }), logger);
  await server.connect(new StdioServerTransport());
  logger.info('mcp-server stdio ready', { tenant: cfg.SELF_HOST_TENANT_SLUG });
}

main().catch((err: unknown) => {
  logger.error('mcp-server stdio failed to start', { err: serializeError(err) });
  process.exit(1);
});

/**
 * Admin script: mint a bearer key for a tenant (hosted streamable-HTTP transport,
 * ADR-012). Inserts sha256(key) into api_keys and prints the plaintext ONCE — it
 * is never stored and cannot be recovered. Not wired into boot or CI. Run against
 * the compose stack (DATABASE_URL from the environment):
 *   pnpm --filter @pet-crypto/mcp-server exec tsx src/keygen.ts <tenant-slug> [label]
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createLogger, serializeError } from '@pet-crypto/core';
import { apiKeys, createDb, tenants, type Db } from '@pet-crypto/db';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { hashKey } from './auth.js';
import { loadConfig } from './config.js';

/** Mint and persist a key for `slug`; returns the plaintext (caller shows it once). */
export async function mintKey(db: Db, slug: string, label?: string): Promise<string> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  const tenantId = rows[0]?.id;
  if (tenantId === undefined) {
    throw new Error(
      `tenant not found: ${slug} — start the stdio server once to create the self-host tenant, or seed the tenant first`,
    );
  }
  const key = randomBytes(32).toString('base64url');
  await db.insert(apiKeys).values({ tenantId, keyHash: hashKey(key), ...(label !== undefined ? { label } : {}) });
  return key;
}

async function runCli(argv: string[]): Promise<void> {
  const logger = createLogger({ name: 'mcp-server:keygen' });
  const [slug, label] = argv;
  if (slug === undefined) {
    logger.error('usage: tsx src/keygen.ts <tenant-slug> [label]');
    process.exit(1);
  }
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  try {
    const key = await mintKey(createDb(pool), slug, label);
    // The plaintext is shown exactly once — copy it into the client's Bearer header.
    process.stdout.write(`${key}\n`);
    logger.info('minted api key', { tenant: slug, label: label ?? null });
  } finally {
    await pool.end();
  }
}

// Runs only when invoked directly (tsx src/keygen.ts …); inert when imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    createLogger({ name: 'mcp-server:keygen' }).error('keygen failed', { err: serializeError(err) });
    process.exit(1);
  });
}

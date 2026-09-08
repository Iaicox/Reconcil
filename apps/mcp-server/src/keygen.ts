/**
 * Admin script: mint a bearer key for a tenant (hosted streamable-HTTP transport,
 * ADR-012). Inserts sha256(key) into api_keys and prints the plaintext ONCE — it
 * is never stored and cannot be recovered. Not wired into boot or CI. Run against
 * the compose stack (DATABASE_URL from the environment):
 *   pnpm --filter @reconcil/mcp-server exec tsx src/keygen.ts <tenant-slug> [label] [--expires-in-days N]
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { serializeError } from '@reconcil/core';
import { apiKeys, createDb, tenants, type Db } from '@reconcil/db';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { hashKey } from './auth.js';
import { loadConfig } from './config.js';
import { createStderrLogger } from './logger.js';

/**
 * Mint and persist a key for `slug`; returns the plaintext (caller shows it once).
 *
 * `expiresInDays` is optional and omitting it mints a non-expiring key — the posture
 * ADR-012 shipped with. Passing it is how a key gets a life shorter than "until someone
 * revokes it", which is the only reason expiry exists.
 */
export async function mintKey(
  db: Db,
  slug: string,
  label?: string,
  expiresInDays?: number,
): Promise<string> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  const tenantId = rows[0]?.id;
  if (tenantId === undefined) {
    throw new Error(
      `tenant not found: ${slug} — start the stdio server once to create the self-host tenant, or seed the tenant first`,
    );
  }
  if (expiresInDays !== undefined && (!Number.isFinite(expiresInDays) || expiresInDays <= 0)) {
    // A key minted already-expired is silently useless; fail where it is noticed.
    throw new Error(`--expires-in-days must be a positive number of days (got: ${String(expiresInDays)})`);
  }
  const key = randomBytes(32).toString('base64url');
  await db.insert(apiKeys).values({
    tenantId,
    keyHash: hashKey(key),
    ...(label !== undefined ? { label } : {}),
    ...(expiresInDays !== undefined
      ? { expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) }
      : {}),
  });
  return key;
}

/** Positional `<slug> [label]` plus an optional `--expires-in-days N`, order-independent. */
export function parseKeygenArgs(argv: string[]): { slug?: string; label?: string; expiresInDays?: number } {
  const positional: string[] = [];
  let expiresInDays: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expires-in-days') {
      const raw = argv[++i];
      const n = Number(raw);
      if (raw === undefined || !Number.isFinite(n)) {
        throw new Error(`--expires-in-days needs a number (got: ${String(raw)})`);
      }
      expiresInDays = n;
    } else {
      positional.push(argv[i]!);
    }
  }
  const [slug, label] = positional;
  return {
    ...(slug !== undefined ? { slug } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
  };
}

async function runCli(argv: string[]): Promise<void> {
  // Logs to stderr so stdout carries only the one-time plaintext key (clean `| head -1`).
  const logger = createStderrLogger('mcp-server:keygen');
  const { slug, label, expiresInDays } = parseKeygenArgs(argv);
  if (slug === undefined) {
    logger.error('usage: tsx src/keygen.ts <tenant-slug> [label] [--expires-in-days N]');
    process.exit(1);
  }
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  try {
    const key = await mintKey(createDb(pool), slug, label, expiresInDays);
    // The plaintext is shown exactly once — copy it into the client's Bearer header.
    process.stdout.write(`${key}\n`);
    logger.info('minted api key', { tenant: slug, label: label ?? null, expiresInDays: expiresInDays ?? null });
  } finally {
    await pool.end();
  }
}

// Runs only when invoked directly (tsx src/keygen.ts …); inert when imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    createStderrLogger('mcp-server:keygen').error('keygen failed', { err: serializeError(err) });
    process.exit(1);
  });
}

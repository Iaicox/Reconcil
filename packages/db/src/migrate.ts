/**
 * Programmatic migrations for app startup (worker boot) — ADR-002. Uses the
 * hand-auditable SQL in ./migrations, NOT drizzle-kit (which is dev tooling).
 * Path resolves the same under tsc dist and vitest src: ../migrations from this
 * module is packages/db/migrations in both.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder });
}

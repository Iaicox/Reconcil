import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated as plain SQL into ./migrations and checked in —
 * the DDL is an audit artifact (ADR-002). Reference DDL:
 * docs/architecture/schema.sql.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://postgres:change-me@localhost:5432/pet_crypto',
  },
});

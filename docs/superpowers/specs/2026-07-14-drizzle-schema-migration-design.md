# Drizzle schema + initial migration — design

**Date:** 2026-07-14 · **Status:** approved (approach A chosen by user) ·
**Package:** `@pet-crypto/db`

## Goal

Turn the reference DDL `docs/architecture/schema.sql` (15 tables) into an
executable Drizzle schema with a generated, hand-auditable SQL migration
`0000`, verified for parity against the reference on a live Postgres 16.

## Approach (decided)

**TS-schema-first.** `src/schema.ts` is written by hand, mirroring
`schema.sql` section by section; `drizzle-kit generate` produces
`migrations/0000_*.sql`, which is reviewed and checked in (ADR-002: migrations
are reviewable SQL, an audit artifact). Parity is proven by applying the
migration and the reference DDL to two fresh databases and diffing
`pg_dump --schema-only` output.

Rejected: SQL-first (`schema.sql` as manual migration + `drizzle-kit pull`) —
introspected TS loses `mode: 'bigint'` and branded types, contradicts ADR-002
"schema in TypeScript". Rejected: hand-writing both artifacts — guaranteed
drift.

## Non-goals

- Tenant-scoped repositories (separate task; ADR-006).
- Running migrations from docker-compose / app startup (worker/server week).
- Seed data for curated `entities` (tenant_id IS NULL rows).
- `RawAmount` branded types — wired later via `.$type<RawAmount>()` once
  `@pet-crypto/core` exposes them; until then money columns are plain `bigint`.

## Package layout

```
packages/db/
  drizzle.config.ts        # already present, unchanged (schema → src/schema.ts, out → migrations)
  src/schema.ts            # all 15 tables; section order and names mirror schema.sql 1:1
  src/client.ts            # createDb(pool): drizzle over node-postgres
  src/index.ts             # re-exports schema + client
  migrations/              # 0000_*.sql + meta/ journal — generated, checked in
```

Single `schema.ts` (not split per domain) is deliberate: the file is the
side-by-side counterpart of `schema.sql`, and 1:1 diffability wins over file
size (~450 lines). Repositories will live in separate files later.

## Column type mapping

| schema.sql | Drizzle (drizzle-orm 0.45.2, verified installed) |
| --- | --- |
| `NUMERIC(78,0)` (base-unit amounts) | `numeric({ precision: 78, scale: 0, mode: 'bigint' })` → JS `bigint` (ADR-004) |
| `NUMERIC` (fiat, price, rate, vat, confidence) | `numeric()` — default string mode; precision never touches JS floats |
| `UUID DEFAULT gen_random_uuid()` | `uuid().defaultRandom()` |
| `BIGINT GENERATED ALWAYS AS IDENTITY` | `bigint({ mode: 'number' }).generatedAlwaysAsIdentity()` — ids/block numbers stay far below 2^53; only money is `bigint`-mode |
| `TIMESTAMPTZ DEFAULT now()` | `timestamp({ withTimezone: true }).defaultNow()` |
| `DATE` | `date()` (string mode) |
| `JSONB` | `jsonb().$type<…>()` — narrow types where the shape is documented, `unknown` for provider `raw` |
| `BYTEA` | `customType` (no native bytea in drizzle-orm) — `integration_credentials.ciphertext/nonce`, JS `Buffer` |
| `TEXT CHECK (x IN (…))` | `text().$type<'a' \| 'b'>()` + named `check()` — keep TEXT+CHECK, no `pgEnum` (matches reference DDL; enum DDL churn avoided) |

## Constraint and index parity

- Named constraints/indexes carry the exact names from `schema.sql`
  (`chain_events_idempotency`, `wallets_address_idx`, …).
- Unnamed inline CHECKs get the names Postgres itself would auto-generate
  (`tokens_decimals_check`, …) so the dump diff is name-clean; exact
  auto-names are confirmed during verification and adjusted if needed.
- `UNIQUE NULLS NOT DISTINCT` → `unique(…).nullsNotDistinct()`
  (`tokens`, `entity_addresses`) — verified available.
- CHECK expressions are copied verbatim into `` check(name, sql`…`) ``,
  including `tokens_native_iff_no_addr` and the lowercase-address checks.
- `ingestion_checkpoints` composite PK via `primaryKey({ columns })`.
- The `exports` table binds to const `exportsTable` (avoids confusion with
  module `exports`); wire name stays `exports`.

## Migration workflow (package scripts)

- `db:generate` → `drizzle-kit generate` (writes `migrations/0000_<slug>.sql`
  + `meta/` journal; SQL is hand-reviewed before commit)
- `db:migrate` → `drizzle-kit migrate` (applies to `DATABASE_URL`; fallback in
  `drizzle.config.ts` matches the compose default)
- `db:check` → `drizzle-kit check` (journal consistency)

`drizzle-kit migrate` records applied migrations in the `drizzle`
schema (`__drizzle_migrations`) — excluded from parity diffs.

## Verification (acceptance criteria)

1. `pnpm build`, `pnpm typecheck`, `pnpm lint` pass at the repo root.
2. Parity check on disposable Postgres 16 (extension of the documented
   docker flow): create two databases in one container; apply
   `migrations/0000_*.sql` to one and `docs/architecture/schema.sql` to the
   other via `psql -v ON_ERROR_STOP=1`; run
   `pg_dump --schema-only --no-owner` on both; diff after excluding the
   `drizzle` bookkeeping schema. **Acceptance: zero semantic differences**;
   any purely cosmetic delta (e.g. constraint auto-name) is either fixed in
   `schema.ts` or explicitly listed in the commit message.
3. `schema.sql` remains the annotated reference; migrations are the
   executable truth. Divergence discovered later is fixed per ADR discipline.

## Error handling / testing

DDL-only change: scripts fail loudly on non-zero exit; no schema-shape unit
tests (they would restate the schema). The live-Postgres parity check is the
test and is repeatable from this doc. `vitest` stays `--passWithNoTests`.

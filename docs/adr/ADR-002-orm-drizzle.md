# ADR-002: ORM — Drizzle (over Prisma)

**Status:** accepted · **Date:** 2026-07-14

## Context

The workload is an aggregation-heavy event ledger: SUM/GROUP BY over `NUMERIC(78,0)`,
window-bounded flow queries, CTEs, `ON CONFLICT DO NOTHING` bulk inserts. Money precision
rules (ADR-004) demand exact control over column types and over how values cross the
JS boundary. Migrations must be reviewable SQL (the DDL is itself an audit artifact).

## Decision

Drizzle ORM + drizzle-kit.

- Schema in TypeScript, migrations generated as plain SQL files, hand-auditable, checked
  into `packages/db`.
- `numeric` columns surface as strings in JS — exactly what the money rules want
  (string → bigint/Decimal at the boundary; a custom column type wraps
  `NUMERIC(78,0) ↔ bigint`).
- The SQL-first query builder (and `sql` template escape hatch) keeps complex
  aggregations typed without hiding the SQL.

## Alternatives considered

- **Prisma** — excellent DX for CRUD apps, but: complex aggregations push into
  `$queryRaw` (losing types exactly where correctness matters most), the query engine
  adds a runtime layer with its own type mappings (`Decimal` objects), and migrations
  are less transparent. The codegen step also fights fast solo iteration.
- **Raw SQL + pg** — maximal control, but hand-maintained types across ~15 tables and
  every query is a real tax; Drizzle costs almost nothing over this and pays types back.
- **Kysely** — closest competitor (typed SQL builder), but schema/migration tooling is
  DIY; Drizzle bundles both.

## Consequences

- All repository code sees Postgres semantics directly; no ORM-invented behavior to debug.
- Migrations are the DDL documentation (schema.sql stays in sync via drizzle-kit).
- Trade-off accepted: fewer batteries than Prisma (no built-in Decimal math, no studio) —
  Decimal handling is deliberately explicit in `packages/core` anyway.

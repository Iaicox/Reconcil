# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Design phase is complete; implementation has not started. The repo contains only the
design pack in `docs/` — there is no `package.json`, no build, no tests yet. When
scaffolding begins, the stack is already decided (pnpm workspaces + Turborepo, TypeScript
strict, Drizzle/Postgres 16, BullMQ/Redis, minimal Fastify host, MCP TypeScript SDK) —
see the ADRs before proposing alternatives. Update this file with real build/test
commands as soon as they exist.

## Source of truth

- `docs/brief.md` — canonical scope, hard principles P1–P12, kill list, validation gate.
  Scope changes are made there first.
- `docs/README.md` — reading order and coverage matrix for the whole design pack.
- `docs/adr/ADR-001…013` — accepted decisions with trade-offs. **Deviating from an ADR
  requires editing that ADR; silent drift in code is not allowed.**
- `docs/architecture/02-mcp-contracts.md` — the tool contract (citation envelope,
  invariants C1–C6). It is a contract, not documentation of convenience.

## Commands

The only runnable artifact today is the schema. Validate DDL changes against a live
Postgres (this exact flow has been verified):

```bash
docker run --rm -d --name schema_check -e POSTGRES_PASSWORD=x postgres:16
docker exec schema_check pg_isready -U postgres   # repeat until ready
docker cp docs/architecture/schema.sql schema_check:/schema.sql
docker exec schema_check psql -U postgres -v ON_ERROR_STOP=1 -q -f /schema.sql
docker rm -f schema_check
```

## Red lines for any code written here

These are the constraints a coding session can violate without noticing; each has an ADR
with full rationale.

- **Money is never `number`.** Canonical amounts are base units in `NUMERIC(78,0)`
  (uint256 does not fit BIGINT); JSON carries money as decimal strings; TS uses
  `bigint`/decimal lib with branded types. Aggregate raw in SQL, scale once at the edge.
  Rounding only at export boundaries. (ADR-004)
- **The LLM never computes.** All figures come from deterministic functions and must be
  traceable through the citation envelope (`tool_call_id`, event refs, pinned
  price/fx snapshot IDs). A number without provenance is a bug. (P1/P2, ADR-012)
- **`chain_events` is append-only.** No UPDATE/DELETE ever; idempotency via
  `UNIQUE (chain_id, tx_hash, log_index)` with sentinel log_index values; ingestion never
  advances past `head − finality_depth` — there is deliberately no reorg rollback path.
  (ADR-005)
- **No signing or key material anywhere in the dependency tree** — the product is
  read-only by construction (MiCA); a dependency-cruiser CI rule will enforce it. (ADR-011)
- **On-chain and imported strings are hostile input.** Only sanitized `*_display` values
  may reach tool responses, and only under `untrusted` keys; `*_raw` and provider `raw`
  JSONB never leave the server. (ADR-011)
- **Tenant identity comes from the transport session, never from tool arguments.**
  All repository methods are tenant-scoped; chain data tables are global by design.
  (ADR-006, ADR-012)
- **MCP tool wire names use underscores** (`analytics_balances`) — dots break the Claude
  API tool-name constraint; `analytics.*` namespaces are logical only. (ADR-012)
- **No Python in this project** — TypeScript/Node only (hard constraint from the brief).

## Conventions

- Repo language is English (docs, code, commit messages) — OSS publication is planned.
- License: Apache-2.0 for everything needed to self-host; `ee/` is reserved for future
  closed SaaS scaffolding and stays empty pre-gate. (ADR-013)

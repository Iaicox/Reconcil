# ADR-003: HTTP layer — minimal Fastify host, no REST API in MVP

**Status:** accepted · **Date:** 2026-07-14

## Context

The product is MCP-first (P11): the primary interface is MCP tools, consumed over stdio
or streamable HTTP. The open question was whether the MVP needs an HTTP framework at all,
and if so which one.

## Decision

No REST/GraphQL API in the MVP. A minimal **Fastify** app exists solely as the process
host for:

- `POST/GET/DELETE /mcp` — MCP streamable HTTP transport (SDK's server transport mounted
  on Fastify routes), with bearer-key tenant resolution (ADR-012);
- `GET /healthz` — container orchestration.

stdio mode bypasses HTTP entirely (separate entrypoint, same tool registry).

## Alternatives considered

- **No HTTP at all (stdio only)** — fails two requirements: the hosted demo needs a
  network transport, and compose needs a health endpoint.
- **NestJS** — a DI framework whose value (module wiring conventions for large teams)
  is negative for a solo project: more indirection, slower iteration, and MCP tools —
  not controllers — are the composition unit here.
- **Express** — no reason to prefer it in 2026: weaker typing, slower, and the brief
  explicitly excludes it.
- **Node `http` directly** — viable, but Fastify's route/lifecycle/logging structure
  costs ~nothing and the post-gate dashboard API will want a real framework anyway.

## Consequences

- The Fastify surface is ~100 lines; the product logic has zero HTTP coupling
  (tools are transport-agnostic functions in `packages/mcp-tools`).
- When the post-gate dashboard arrives, REST/RPC endpoints join the existing Fastify app
  with Zod type-providers — no migration.
- Zod validates tool inputs regardless of transport, so HTTP adds no validation path.

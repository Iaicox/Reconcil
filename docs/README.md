# Design Documentation

On-chain accounting ledger with an MCP-native interface. Designed 2026-07-14, to
implementation-ready state. Start here.

## Reading order

1. [`brief.md`](brief.md) — canonical product brief: scope, constraints, roadmap, gate.
2. [`architecture/00-overview.md`](architecture/00-overview.md) — C4 context & containers, bounded contexts, monorepo, deployment.
3. [`architecture/01-data-model.md`](architecture/01-data-model.md) — data model rationale (+ [`schema.sql`](architecture/schema.sql), applies to `postgres:16`).
4. [`architecture/02-mcp-contracts.md`](architecture/02-mcp-contracts.md) — tool contracts: envelope, citation invariants, every tool schema, sanitization.
5. [`architecture/03-ingestion.md`](architecture/03-ingestion.md) — ingestion state machine, queues, providers, backfill, finality.
6. [`architecture/04-testing.md`](architecture/04-testing.md) — fixtures, property invariants, agent evals, demo gate.
7. [`architecture/05-risks-open-questions.md`](architecture/05-risks-open-questions.md) — top-5 risks, open questions.
8. [`adr/`](adr/) — 13 decision records (below).

## ADR index

| ADR | Decision |
|---|---|
| [001](adr/ADR-001-monorepo-pnpm-turborepo.md) | Monorepo: pnpm workspaces + Turborepo |
| [002](adr/ADR-002-orm-drizzle.md) | ORM: Drizzle (over Prisma) |
| [003](adr/ADR-003-http-minimal-fastify.md) | HTTP: minimal Fastify host, no REST in MVP (NestJS rejected) |
| [004](adr/ADR-004-money-representation.md) | Money: `NUMERIC(78,0)` base units, strings on the wire, float ban |
| [005](adr/ADR-005-event-store.md) | Event store: append-only, `(chain, tx, log_index)` idempotency, gas-as-event, finality lag |
| [006](adr/ADR-006-tenancy.md) | Tenancy: global chain data + tenant-owned tracking; repository scoping |
| [007](adr/ADR-007-pricing-snapshots.md) | Pricing: daily UTC snapshots, DefiLlama/CoinGecko + ECB, FK-pinned |
| [008](adr/ADR-008-queues-and-backfill.md) | Jobs: BullMQ topology; full-history backfill + anchored-window fallback |
| [009](adr/ADR-009-provider-abstraction.md) | Providers: capability interface; chains as configuration |
| [010](adr/ADR-010-matching-engine.md) | Matching: source-agnostic records, m:n legs, deterministic scoring, HITL |
| [011](adr/ADR-011-sanitization-and-guardrails.md) | Hostile strings: sanitize + isolate + eval; MiCA guardrails |
| [012](adr/ADR-012-mcp-transport-auth.md) | MCP transport: stdio + streamable HTTP; bearer now, OAuth post-gate |
| [013](adr/ADR-013-open-core-licensing.md) | Open-core: Apache-2.0 everything self-host; `ee/` reserved |

## Coverage matrix

**Session artifacts (brief) → documents**

| Required artifact | Where |
|---|---|
| Architecture overview: C4, bounded contexts, monorepo | `00-overview.md` |
| Core data schema at DDL level, with indexes & key rationale | `01-data-model.md` + `schema.sql` |
| MCP tool contracts: schemas, citation invariants, namespaces | `02-mcp-contracts.md` |
| Ingestion pipeline: state machine, checkpoints, reorgs, backfill, limits | `03-ingestion.md` |
| ADR pack (8–12+) with trade-offs | `adr/ADR-001…013` |
| Test plan: golden fixtures, property tests, agent evals with pass metric | `04-testing.md` |
| Top-5 risks and open questions with proposed solutions | `05-risks-open-questions.md` |

**Open decisions (brief) → resolutions**

| Decision | Resolution | Where |
|---|---|---|
| Monorepo tool & package layout | pnpm + Turborepo; 3 apps / 9 packages | ADR-001, 00 §4 |
| Prisma vs Drizzle | Drizzle | ADR-002 |
| Fastify vs NestJS; HTTP needed at all? | Minimal Fastify host only (`/mcp`, `/healthz`); no REST in MVP | ADR-003 |
| Amount storage & conversion rules | `NUMERIC(78,0)` raw; aggregate raw, scale at edge; strings on wire | ADR-004, 01 §2 |
| Backfill: full vs window; prioritization | Full by default; anchored window > 50k txs; live > backfill | ADR-008, 03 §3 |
| MCP transport & tool auth | stdio (self-host) + streamable HTTP (bearer) ; OAuth post-gate | ADR-012, 02 §9 |
| Eval dataset format & demo gate | YAML cases, deterministic graders; citations/guardrails/injections 100%, numeric ≥ 90% (27/30, 2-of-3) | 04 §5–6 |

**Hard principles (P1–P12) → enforcement**

| P | Principle | Where enforced |
|---|---|---|
| P1 | LLM never computes | 00 §1 (LLM boundary), ADR-010 (deterministic matcher), 04 G2 anti-fabrication |
| P2 | Every figure traceable | 02 §2–3 (envelope, C1–C6), `tool_calls` table, `ledger_trace_tool_call` |
| P3 | Event-sourced ledger | 01 §3, ADR-005 |
| P4 | Idempotent ingestion | 03 §3 (transactional cursor + ON CONFLICT), 04 invariant 5–6 |
| P5 | Persistent price snapshots | ADR-007, pinned FKs in `matches`/manifests |
| P6 | Multi-provider abstraction | ADR-009, 03 §5 |
| P7 | On-chain strings are hostile | 02 §7, ADR-011, `*_raw` vs `*_display` split |
| P8 | MiCA red lines | ADR-011 (dep-cruiser signing ban, guardrail evals, drafts) |
| P9 | Client secrets encrypted, never logged | 01 §7 (`integration_credentials`), log-scrub test in 04 |
| P10 | Self-host first-class, multi-tenant schema | 00 §5, ADR-006 |
| P11 | MCP-first | ADR-003, ADR-012, 02 |
| P12 | Eval harness mandatory | 04 §5–6 (gate blocks demo publication) |

**Option C seams:** source-agnostic matching → ADR-010; chains as config → ADR-009 / 03 §7.

## Status

Design complete; implementation not started. Next actions: scaffold the monorepo
(week 1), capture the first provider fixtures, stand up `db` migrations from
`schema.sql`. Kill list and gate criteria: `brief.md`.

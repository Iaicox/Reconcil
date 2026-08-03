# Contributing

How to build, test, and extend the codebase without breaking the guarantees the product
rests on.

## Setup

```bash
pnpm install     # Node >= 22.12, pnpm 11 (both pinned in package.json)
pnpm build       # turbo run build → tsc -b across project references
```

`pnpm build` is not optional before other checks: the workspace uses TypeScript project
references, and `depcruise` resolves cross-package imports through built `dist/` entrypoints.
A cold clone that skips the build gets confusing failures from tools that are working
correctly.

## Commands

```bash
pnpm build              # tsc -b (this is also the typecheck)
pnpm typecheck          # build-ordered tsc -b
pnpm lint               # eslint per package (flat config at the root)
pnpm test               # vitest per package (--passWithNoTests where there are none)
pnpm depcruise          # dependency direction + signing-library ban — run after build
pnpm check:supply-chain # lockfile scan for signing/key-material packages
pnpm smoke:compose      # full compose stack + stdio client + tool calls, then tears down
```

Per-package integration tests (testcontainers Postgres, needs Docker):

```bash
pnpm --filter @reconcil/mcp-tools test:integration
pnpm --filter @reconcil/db test:integration
# also: ingestion, ledger, pricing, evals, mcp-server
```

Dev entrypoints (tsx, no image rebuild):

```bash
pnpm --filter @reconcil/mcp-server dev        # stdio
pnpm --filter @reconcil/mcp-server dev:http   # Fastify on :8484
pnpm --filter @reconcil/worker dev
pnpm --filter @reconcil/cli dev repl
```

## Layout

Three apps, nine packages. Dependencies flow strictly one way, and dependency-cruiser
enforces it (`.dependency-cruiser.cjs`).

```
apps/
  mcp-server/   stdio + streamable HTTP hosts; the transport adapter, nothing more
  worker/       BullMQ processors: backfill, tail, anchor, probe, prices, onboarding
  cli/          thin agent: demo REPL + eval runner (Anthropic SDK Tool Runner)
packages/
  core/         domain types, Zod schemas, Money, sanitizer, chain config — imports nothing internal
  db/           Drizzle schema, migrations, tenant-scoped repositories — depends only on core
  ingestion/    provider adapters, normalizer, checkpoint state machine
  pricing/      DefiLlama / CoinGecko / ECB adapters, snapshot service
  ledger/       deterministic aggregations: pure functions + SQL builders
  recon/        matching engine (pure), match lifecycle
  exporters/    close pack, PDF, journal CSV — pure render layer, core only
  mcp-tools/    tool implementations: envelope, citations, scoping, repositories
  evals/        golden fixtures, eval dataset, deterministic graders
ee/             reserved for post-gate closed SaaS scaffolding; empty (ADR-013)
site/           landing page — deliberately outside the pnpm workspace (npm, Next.js)
```

The enforced rules: `core` imports nothing internal · `db` depends only on `core` ·
domain packages depend only on `db` and `core` · `mcp-tools` sits above them · nothing
imports `apps/*` · no cross-app imports · no cycles.

## Test pyramid

| Layer | Tooling | When |
|---|---|---|
| Unit — money math, sanitizer, normalizer, matcher scoring | vitest | every commit |
| Property — aggregation and matching invariants | vitest + fast-check | every commit |
| Contract — tool schemas vs golden JSON | vitest snapshots | every commit |
| Integration — fixtures in, ledger asserted | vitest + testcontainers Postgres | every commit |
| E2E smoke — compose up, stdio client, tool calls | `pnpm smoke:compose` | pre-release |
| Agent evals — 30 cases, deterministic graders | `packages/evals` + CLI runner | smoke on PR, full nightly |

**No test touches the network.** Providers replay from recorded fixtures. If a change needs a
new fixture, record it — do not add a live call.

Snapshot updates use `pnpm exec vitest run -u` inside the package, not `pnpm test -- -u`.

### Agent evals

```bash
export ANTHROPIC_API_KEY=sk-ant-…
pnpm --filter @reconcil/cli evals -- --suite core --runs 3
pnpm --filter @reconcil/cli evals -- --smoke        # 6-case subset, 1 run
```

Cases live in `packages/evals/fixtures/evals/core-30.yaml`; graders are deterministic
(trajectory, numeric, citation, guardrail, injection). The demo-readiness gate: safety
metrics (citations, guardrails, injections) must be **100%**, numeric and trajectory **≥ 90%
by majority of 3 runs**. A failing gate exits non-zero and blocks the demo.

The runner provisions its own Postgres via testcontainers if `DATABASE_URL` is unset.

## CI

| Job | Trigger | Contents |
|---|---|---|
| `check` | PR + main | install, build, lint, depcruise, supply-chain scan |
| `test` | PR + main | unit + property + contract |
| `schema-parity` | PR + main | Drizzle migrations vs `docs/architecture/schema.sql`, `pg_dump` diff must be empty |
| `integration` | PR + main | testcontainers Postgres per suite, fixture ingest, ledger assertions |
| `evals-smoke` | PR | 6-case subset, 1 run — cheap contract-drift catch |
| `evals-full` | nightly + manual | 30 cases × 3 runs, publishes a scorecard artifact |
| `e2e-smoke` | manual / pre-release | the real compose stack (`pnpm smoke:compose`) |

All of the above are jobs of the single `ci` workflow, which also runs on the nightly
schedule and on manual dispatch; a small `evals-preflight` helper job resolves whether
`ANTHROPIC_API_KEY` is present. That key is used only by `evals-*`. Provider keys are never
needed in CI. A missing key makes the eval jobs **skip**, never fail red.

## Red lines

Each has an ADR with full reasoning. These are the constraints a coding session can violate
without noticing.

- **Money is never `number`.** Canonical amounts are base units in `NUMERIC(78,0)` — uint256
  does not fit in `BIGINT`. JSON carries money as decimal strings; TypeScript uses `bigint` or
  a decimal library with branded types. Aggregate raw in SQL, scale once at the edge, round
  only at export boundaries. (ADR-004)
- **The LLM never computes.** Every figure comes from a deterministic function and must be
  traceable through the citation envelope. A number without provenance is a bug. (P1/P2, ADR-012)
- **`chain_events` is append-only.** No UPDATE, no DELETE, ever. Idempotency via
  `UNIQUE (chain_id, tx_hash, log_index, token_id)`; ingestion never advances past
  `head − finality_depth`; there is deliberately no reorg rollback path. (ADR-005)
- **No signing or key material anywhere in the dependency tree.** Read-only by construction
  (MiCA). Enforced by depcruise plus a lockfile scan. (ADR-011)
- **On-chain and imported strings are hostile.** Only sanitized `*_display` values may reach
  tool responses, and only under `untrusted` keys. `*_raw` string fields and provider `raw`
  JSONB never leave the server. (The trusted numeric `amount_raw` — uint256 base units as a
  decimal string — is not hostile input and does cross the wire.) (ADR-011)
- **Tenant identity comes from the transport session, never from tool arguments.** All
  repository methods are tenant-scoped; chain data tables are global by design. (ADR-006, ADR-012)
- **MCP wire names use underscores.** `analytics_balances`, not `analytics.balances` — dots
  break the Claude API tool-name constraint. (ADR-012)
- **No Python.** TypeScript and Node only.

**Deviating from an ADR requires editing that ADR.** Silent drift in code is not allowed —
that rule is what keeps the design pack trustworthy.

## Adding a tool

1. **Schema first.** Input and output Zod schemas in `packages/core`. They are the source of
   truth; the published JSON Schema is generated from them with `z.toJSONSchema`, and outputs
   are validated at runtime — a tool that violates its own contract fails loudly.
2. **Handler** in `packages/mcp-tools/src/tools/<name>.ts`, exporting `TOOL_NAME` and a
   `(ctx, input) => Promise<ToolEnvelope<T>>` function. Reuse `resolveScope`, `buildEnvelope`,
   `selectRefs`, `mapCoverage`, `toTokenView`.
3. **Writes go through `runWriteTool`** (`write-tx.ts`), which commits the mutation and the
   `tool_calls` audit row in one transaction (C2).
4. **Register** it in `packages/mcp-tools/src/index.ts` (`tools`) with the right annotations,
   and add its one-liner to `descriptions.ts` — that text is what clients see.
5. **Document it** in `docs/architecture/02-mcp-contracts.md` §6 and add a row to
   [the cheat sheet](06-tool-cheatsheet.md).
6. **Test**: hermetic unit tests, an integration test against testcontainers, and bump the
   expected tool count in `apps/mcp-server/src/compose-smoke.ts` and the mcp-server tests.

## Adding a chain

One entry in `packages/core/src/chains.config.ts` — chain id, native token, finality depth,
poll interval, fee strategy, provider list, and (for OP-stack chains) the RPC env var. No
code changes. That "chains are configuration" property is a deliberate architectural seam
(ADR-009); keep it.

## Working with the board

The maintainer tracks tasks on a local kanbn board in `.kanbn/` — it is **gitignored**, so a
clone does not contain it and external contributors can ignore this section. If you work with
the maintainer directly: keep the card current, blockers go in the card as a comment plus a
`blocked` tag, the task id comes from the card's H1 heading, and the column lives only in
`index.md`. Everyone else: open a GitHub issue or PR.

## Conventions

- Repo language is **English** — docs, code, comments, commit messages. OSS publication is
  planned.
- License: Apache-2.0 for everything needed to self-host. `ee/` is reserved for future closed
  SaaS scaffolding and stays empty pre-gate (ADR-013).
- Scope changes start in [`docs/brief.md`](../brief.md), the canonical scope document — then
  the architecture docs, then the code.

## Next

- [`docs/README.md`](../README.md) — the full design pack and reading order.
- [`docs/architecture/02-mcp-contracts.md`](../architecture/02-mcp-contracts.md) — the tool contract.
- [`docs/architecture/04-testing.md`](../architecture/04-testing.md) — the full testing and eval strategy.

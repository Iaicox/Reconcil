# ADR-001: Monorepo — pnpm workspaces + Turborepo

**Status:** accepted · **Date:** 2026-07-14

## Context

One backend, ~12 TypeScript packages (3 apps, 9 libraries), one solo developer. Needs:
strict internal boundaries (dependency direction), fast incremental check/test/build,
near-zero tooling maintenance. CI-scale optimization is irrelevant pre-gate.

## Decision

pnpm workspaces for package linking; Turborepo as the task runner (`turbo.json`: `build`,
`typecheck`, `lint`, `test` with dependency-ordered, cached execution). TypeScript
project references for incremental typechecking; `tsx` for dev execution, `tsc -b` for
builds. Boundary enforcement via dependency-cruiser (also bans signing libraries — P8).

*Amended 2026-09-15 (ADR sweep — accuracy).* "Boundary enforcement" is narrower than the
layer graph `.dependency-cruiser.cjs` documents at the top of itself
(`apps/* → mcp-tools → { ledger, recon, exporters, pricing } → db → core`). The ten rules
constrain `core`, `db`, the domain packages, `mcp-tools`, `evals`, circularity and
resolvability — but **no rule constrains what `apps/*` may import from `packages/*`**.
`nothing-imports-apps` and `no-cross-app-imports` are different directions, and
`not-to-unresolvable` is not a backstop either, because the root workspace declares
`@reconcil/ingestion` as a devDependency (see `09-known-gaps.md`) so an undeclared import
from an app still resolves by node_modules walk-up. No app violates the graph today; the
edge is simply unguarded, and that gap is tracked in `09-known-gaps.md` rather than closed
here. The signing-library half of this sentence is also not what delivers its stated scope
— see ADR-011.

## Alternatives considered

- **Nx** — powerful (generators, graph, plugins) but a framework with its own concepts,
  daemon, and upgrade treadmill. The payoff appears at team scale; solo it is pure
  overhead.
- **pnpm workspaces alone** — viable, but cross-package task ordering and caching become
  hand-rolled scripts; turbo does exactly that for one small JSON file.
- **Polyrepo** — rejected outright: the core/tools/evals packages co-evolve daily.

## Consequences

- One `pnpm install`, one `turbo run test` — whole-repo feedback in seconds once cached.
- Turbo remains removable (it only orchestrates package.json scripts) — no lock-in.
- The open-core split (ADR-013) maps to workspace globs later (`packages/*` public,
  `ee/*` private) without restructuring.

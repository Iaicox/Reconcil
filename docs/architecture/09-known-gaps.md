# Known Gaps & Deferred Items

A permanent register of everything deliberately left undone by the 2026-08 remediation
arc — 17 review-driven PR slices (`fix/token-seed` … `chore/pricing-ledger-minors`, each
its own branch off `612def4`) plus the doc/ADR sweep that closed the arc. The arc was
written in 2026-08 and landed on `main` in 2026-09; entries tagged *(landing sweep)* were
found during that landing, not during the arc itself. Nothing here is an oversight: every
entry was seen, judged not worth blocking the slice on, and recorded instead of left as
silent drift. Each entry states what it is, why it was deferred, what would trigger doing
it, and exactly where it lives.

Source of truth for provenance: `.superpowers/sdd/logical-stargazing-clover/progress.md`
(the execution ledger for the arc). Entries tagged *(sweep)* were not on that ledger —
they surfaced while cross-checking ADRs and contract docs against shipped behavior for
this same doc-sync slice, and are recorded here because they are exactly the kind of
decision this register exists to hold. This document does not restate ADR rationale —
where an item is really an ADR-level trade-off, it links to the ADR instead of repeating it.

Every branch referenced here has since merged, so all file references describe `main`.

## Ingestion

**`commitPage` paused-guard still runs `insertEventRows`.** The paused guard freezes the
checkpoint's cursor and status, but the page's event rows are still inserted underneath it.
Why deferred: idempotent and benign — `ON CONFLICT DO NOTHING` means a paused stream that
still receives a page just records events it will re-derive anyway once resumed. Trigger:
promote to a real fix (skip the insert too) if a paused-but-inserting stream ever causes an
observable inconsistency, or as part of a general checkpoint-state-machine hardening pass.
Where: `packages/ingestion/src/write/checkpoint-repo.ts` (`commitPage`). *(Task 6,
`fix/ingestion-cursor`)*

**Concurrent `commitPage` races can let an older status win.** Two concurrent
`ingestOnce` calls for the same stream can interleave so a stale status overwrites a
fresher one. Why deferred: self-correcting on the next tick (the next `ingestOnce` reads
current state and writes forward), and concurrent calls for one stream are not the normal
operating mode. Trigger: add a compare-and-swap (status + cursor) if a second concurrent
ingestion path is ever introduced deliberately (today it only happens under operator
error). Where: `packages/ingestion/src/write/checkpoint-repo.ts` (`commitPage`). *(Task 6,
`fix/ingestion-cursor`)*

**Spurious warn log possible under concurrent `ingestOnce` with a lagging RPC head.** A
benign log-noise case, not a correctness issue. Why deferred: cosmetic; fixing it means
threading more state through the hot path for a log line. Trigger: revisit if the noise
starts obscuring real warnings in production logs. Where:
`packages/ingestion/src/processors/ingest.ts`. *(Task 6, `fix/ingestion-cursor`)*

**Etherscan `internalRow` zod schema should union `string | number` for `traceId`/`index`.**
Currently typed as one or the other; a provider response using the other shape is a latent
hard parse failure. Why deferred: not observed in the wild yet, and internal transfers are
themselves a new stream (rolled into a later hardening slice by design). Trigger: the first
real parse failure on a live Etherscan/Blockscout response, or proactively before the
internal-transfers stream goes to production traffic. Where:
`packages/ingestion/src/providers/etherscan-v2.ts` (`internalRow`, on
`feat/internal-transfers`). *(Task 7, `feat/internal-transfers`)*

**`compareTraceIds` has an inconsistent comparator for mixed numeric/non-numeric trace
labels.** Why deferred: unreachable today — Etherscan and Blockscout both send one
consistent label shape per response; the mixed case has no known trigger. Trigger: a
provider that returns mixed numeric/string trace labels within one page, or a new provider
integration. Where: `packages/ingestion/src/normalize.ts` (`compareTraceIds`, on
`feat/internal-transfers`). *(Task 7, `feat/internal-transfers`)*

**`sentinelRank.get(...) ?? 0` silently defaults instead of throwing.** A lookup miss
should be impossible by construction (every arrival is ranked before lookup) but silently
returns `0` — a real slot collision — rather than failing loudly. Why deferred: judged
correct-by-inspection, not proven by a test; not worth blocking the internal-transfers
slice for a defensive assertion. Trigger: fold into the same hardening pass as the zod
union item above; add the throw once the invariant has an owning test. Where:
`packages/ingestion/src/normalize.ts` (`sentinelRank`, on `feat/internal-transfers`).
*(Task 7, `feat/internal-transfers`)*

**Availability-asymmetry sentence in `03-ingestion.md` §4 goes stale once internal
transfers wire up.** Why deferred: `feat/internal-transfers` already rewrites large parts
of that file; this one sentence was left as a known follow-up rather than block the
branch on prose polish. Trigger: pick up whenever `feat/internal-transfers` (or a
successor slice) next touches §4. Where: `docs/architecture/03-ingestion.md` §4, on
`feat/internal-transfers`. *(Task 7, `feat/internal-transfers`)*

**Stale `§11` comment citation and a no-op `{...q}` object copy.** A comment cites a
section number that has since moved, and a spread expression that materializes an object
`{...q}` without ever mutating it. Why deferred: cosmetic; no behavior change either way.
Trigger: next time someone is editing the surrounding code for a real reason. Where:
`packages/ingestion/src/{paging.ts,processors/ingest.ts,providers/etherscan-v2.ts,types.ts}`
(the `§11` cites and the `{ ...q }` calls), on `feat/internal-transfers`. *(Task 7,
`feat/internal-transfers`)*

**Provider stamp can mislabel across a mid-page provider failover.** If Etherscan fails
mid-page and Blockscout finishes it, the page's recorded "provider" stamp can point at the
wrong one for the tail of the page. Why deferred: accepted as-is — the audit trail column
is not read by any user-facing figure (P1/P2 traceability runs through
`tool_call_id`/citations, not this column), so the mislabel has no correctness impact,
only a cosmetic audit-log inaccuracy. Trigger: revisit only if the provider-stamp column
becomes load-bearing for some future audit surface. Where:
`packages/ingestion/src/{processors/ingest.ts,providers/provider-factory.ts}`, on
`feat/internal-transfers`. *(Task 7, `feat/internal-transfers`)*

**No test for `status='live'` with zero net advance.** The early-return path (a stream
that is already caught up and advances zero blocks this tick) is believed correct by code
inspection but isn't pinned by a test. Trigger: pin it the next time `apps/worker/src/
main.ts`'s checkpoint-status logic changes for an unrelated reason (cheap to add
alongside any other edit there). Where: `apps/worker/src/main.ts`. *(Task 12,
`fix/worker-queues`)*

**`getCheckpointBlock`'s `undefined` branch is untested.** A second, separate coverage
gap in the same status logic (checkpoint lookup returning nothing for a stream) noted
alongside the `status='live'` gap above but exercising a different code path. Trigger:
same as above — pin alongside the next unrelated edit to that logic. Where:
`apps/worker/src/main.ts` (`getCheckpointBlock`). *(Task 12, `fix/worker-queues`)*

## Ledger

**`isRealCalendarDate` re-splits a string `parseIsoDateComponentsUtc` already parsed.**
Tidiness only — no behavior difference, just redundant work on a validation hot path.
Trigger: fold into whatever slice next touches date validation in `schemas.ts`. Where:
`packages/core/src/schemas.ts` (`isRealCalendarDate`). *(Task 5, `fix/calendar-dates`)*

**`TimeWindow`'s docstring says it "mirrors SQL `BETWEEN`" (closed-inclusive), but the
scope-SQL helpers now build a half-open `[from, toExclusive)` range.** The conversion
between the two representations is documented only on the helper that does it, not on the
type itself, so a reader of `TimeWindow` alone gets the wrong mental model. Why deferred:
the fold logic itself is correct (verified by ledger integration tests); this is a
documentation-debt item inside a source file — out of scope for a docs-only slice to touch
directly. Trigger: next edit to `packages/ledger/src/types.ts` or `scope-sql.ts`. Where:
`packages/ledger/src/types.ts` (`TimeWindow` docstring) and `packages/ledger/src/
scope-sql.ts` (`periodRange`/`timeBetween`, the half-open conversion). *(Task 8,
`fix/ledger-status-scope`)*

**No named integration test for gas-only-wallet stream freshness.** A wallet with only
gas activity (no token/native transfers) exercises a freshness code path that isn't
independently pinned by its own test case. Trigger: add the missing case the next time
`ledger_status` freshness logic changes. Where: `packages/ledger/test/ledger.itest.ts`.
*(Task 8, `fix/ledger-status-scope`)*

**`as_of ≡ fold` oracle-parity check has a pre-existing gap.** A second, distinct
coverage gap noted alongside the one above: the check that an `as_of`-scoped read equals
a full fold of events up to that point has always had this gap — not introduced by this
arc, just observed while working in the area. Trigger: close it as part of any future
freshness/fold-correctness hardening pass. Where: `packages/ledger/test/ledger.itest.ts`.
*(Task 8, `fix/ledger-status-scope`)*

## Pricing

## Face B (reconciliation & matching)

**The subset-search heuristic's known miss-mode: the candidate pool is the ≤ 6
largest-valued events in the date window, not "any ≤ 6 events."** An exact split whose
smallest member falls outside that top-6-by-size pool is unreachable by the search, even
though ≤ 6 events would in principle suffice — a second, independent miss-mode from the
already-documented "needs a larger combination" case. Why deferred: a conscious complexity
cap (ADR-010), now characterization-tested so widening the pool later is a deliberate
choice, not an accidental behavior change; records the search misses simply stay
`open`/`partial` for manual matching — a visible, honest failure mode, not silent
incorrectness. Trigger: real invoice data shows the small-member-outside-top-6 case often
enough to justify a larger or smarter pool (e.g. also including the ≤ 6 smallest, or a
proper bounded subset-sum). Where: `packages/recon/src/match/engine.ts`
(`MAX_SUBSET_EVENTS`, `findBestSubset`); documented in the ADR-010 amendment (2026-08-06,
"Honest subset-search wording"). *(sweep — ADR-010 amendment on `fix/match-engine-edges`)*

**`score.ts`'s weight-rescale branch is unreachable by the current `WEIGHTS` and untested;
there is no final bound if `WEIGHTS` is ever retuned above 1.** The rescale exists to keep
`Σ weights === confidence` exact under float summation (see the ADR-010 amendment,
"Exact `Σ weights === confidence` under the clamp"), but nothing currently forces the
branch to execute, and nothing bounds a future retune that pushes the raw sum well past 1.
Trigger: retuning `WEIGHTS` (a real possibility — scoring weights are exactly the kind of
thing that gets tuned against real data). Where: `packages/recon/src/match/score.ts`.
*(Task 9, `fix/match-engine-edges`)*

**`hydratePriceRefs`/`hydrateFxRefs` don't `ORDER BY`, so the returned refs array isn't
run-stable when ≥ 2 ids are requested.** Not a correctness issue (the refs are looked up
by id into a `Map`, so order doesn't affect which ref attaches to which leg) but it does
mean two runs of the same tool call can emit citations in a different array order.
Trigger: if citation array order is ever asserted on in a test or relied on by a
downstream consumer. Where: `packages/mcp-tools/src/pricing-refs.ts`
(`hydratePriceRefs`/`hydrateFxRefs`, on `fix/face-b-envelope`). *(Task 10,
`fix/face-b-envelope`)*

**`mapStatusCounts` uses the `in` operator (which also sees prototype-chain members)
instead of `Object.hasOwn`.** Why deferred: not exploitable — the object being tested is
an internal literal with a known, closed shape, not user input. Trigger: fold into a
general "no bare `in` on untrusted or dynamic objects" lint pass if one is ever added.
Where: `packages/mcp-tools/src/recon/status-repo.ts` (`mapStatusCounts`, on
`fix/face-b-envelope`). *(Task 10, `fix/face-b-envelope`)*

**No integration test for mixed volatile+stablecoin journal ref-coverage or
shared-snapshot dedup.** Coverage gap, not a known bug. Trigger: add before journal
drafts are extended to a currency mix beyond what's tested today. Where:
`packages/mcp-tools/test/export-journal-drafts.itest.ts`. *(Task 10, `fix/face-b-envelope`)*

**No journal-path `fx_refs` cross-currency integration test.** A second, distinct
coverage gap noted alongside the one above: a journal draft that actually needs FX
conversion (not just price refs) across currencies has no dedicated itest. Trigger: same
as above. Where: `packages/mcp-tools/test/export-journal-drafts.itest.ts`. *(Task 10,
`fix/face-b-envelope`)*

**`export-journal-drafts.ts`'s edit in the exporters-hardening slice slightly exceeds the
"two one-liners" merge-surface guidance.** A process note, not a technical gap: the extra
surface was a justified comment expansion, recorded here only so the deviation from the
arc's own merge-surface discipline is explained rather than silent. No action needed.
Where: `packages/mcp-tools/src/tools/export-journal-drafts.ts`, on
`chore/exporters-hardening`. *(Task 16, `chore/exporters-hardening`)*

## Transport & auth

**`destroy()` on an already-completed response could, in principle, RST a reply that was
actually delivered.** Low-probability race in the hijacked-transport error path: if the
response finished between the `headersSent` check and the `destroy()` call, the client
could see a reset instead of a clean close. Trigger: revisit if this ever shows up as a
flaky client-side error. Where: `apps/mcp-server/src/http.ts`
(`handleHijackedTransport`). *(Task 11, `fix/server-transport`)*

**`hashKey` is computed twice per authenticated request.** Pure performance nit (sha256
over a short string, twice, per request) — not a correctness issue. Trigger: revisit if
auth-path latency ever becomes a measured concern. Where: `apps/mcp-server/src/auth.ts`
(`hashKey`). *(Task 11, `fix/server-transport`)*

**`HttpDeps.allowedHosts = []` bypasses `resolveAllowedHosts`'s empty-guard.** An explicit
empty array (as opposed to `undefined`) skips the fallback-to-defaults logic. Why
deferred: not attacker-reachable — `allowedHosts` is an injectable test seam, not a
request-controlled value; production always calls `resolveAllowedHosts(cfg)`. Trigger:
tighten if `HttpDeps` construction is ever exposed to less-trusted callers. Where:
`apps/mcp-server/src/{http.ts,config.ts}`. *(Task 11, `fix/server-transport`)*

## Exporters

**Export I/O reads the path before its `realpath` re-check (TOCTOU).** The confinement
check re-validates via `realpath` after resolving the path, but the actual write still
happens against the pre-`realpath` path string, leaving a narrow window for a co-resident
writer to swap a path component via symlink between check and use. Why deferred: the
threat model here is a co-resident writer with filesystem access to the export directory —
already inside the trust boundary the export root assumes; not the model-controlled-input
threat (H2) the confinement logic was built to close. Trigger: revisit if the export
directory is ever shared with a less-trusted co-tenant process. Where:
`packages/mcp-tools/src/fs-confine.ts` and `packages/mcp-tools/src/tools/export-run.ts`.
*(Task 2, `fix/export-out-dir`)*

**`fs-confine.ts`'s prefix comparison is case-sensitive on Windows.** Inherited behavior,
not introduced by this arc. Why deferred: fails safe — a case-mismatched path is rejected
as an escape rather than incorrectly accepted, so the failure mode is "confinement is
stricter than necessary on Windows," not a bypass. Trigger: if self-host Windows
deployments become common enough that the over-rejection is a real usability complaint.
Where: `packages/mcp-tools/src/fs-confine.ts` (`resolveWithinBase`). *(Task 2,
`fix/export-out-dir`)*

**`out_dir` of `""` or `"."` isn't explicitly tested**, though it's provably equivalent to
the already-tested case (both resolve to the export root itself). Trigger: add the
explicit case the next time the export confinement tests are touched — cheap, just not
done yet. Where: `packages/mcp-tools/test/export*.itest.ts`. *(Task 2,
`fix/export-out-dir`)*

## Build & CI

**`migrate.itest.ts`'s comment claims the migration runs in "the same container" as
another step, but the block actually spins its own.** Doc-comment inaccuracy inside a
test file — needs a reword, not a behavior change. Trigger: next edit to that test file.
Where: `packages/db/test/migrate.itest.ts:39-41`. *(Task 1, `fix/token-seed`)*

**`Dockerfile`'s `EXPOSE 8484` is stale relative to the `PORT` env override** — `EXPOSE` is
documentation-only in Docker (it doesn't bind the port), so this is non-binding drift, not
a functional bug. Trigger: bundle a fix in whenever the Dockerfile is next edited for an
unrelated reason. Where: `Dockerfile`. *(Task 12, `fix/worker-queues`)*

**The `SMOKE_IDS` set is a literal Set; a duplicate entry would silently shrink the
required eval-case count instead of erroring.** A size-based invariant limitation that's
inherent to the current design (checking `SMOKE_IDS.size` against an expected count can't
distinguish "shrunk because of a duplicate" from "shrunk on purpose"). Trigger: switch to
an array + explicit dedup-check if `SMOKE_IDS` ever grows large enough that a silent
duplicate becomes a real risk. Where: `apps/cli/src/run.ts` (`SMOKE_IDS`). *(Task 13,
`fix/evals-cli`)*

**The workspace-consistency commit rationale overstated its own scope: `db` and `recon`
still use `vitest run --passWithNoTests`, unlike `ledger`/`mcp-tools`.** Confirmed still
true on `main` today. Trigger: align the two remaining packages the next time test-config
consistency work resumes (this was flagged as a candidate for the typecheck-tests slice,
which did not end up touching these two files). Where: `packages/db/package.json:18`,
`packages/recon/package.json:18`. *(Task 13, `fix/evals-cli`)*

**`export-dir.test.ts` asserts `rejects.toThrow()` without pinning the original error.**
A looser-than-ideal test assertion — it would pass even if the thrown error's type or
message changed to something equally wrong. Trigger: tighten the next time that test file
is touched. Where: `apps/cli/test/export-dir.test.ts`. *(Task 13, `fix/evals-cli`)*

**The supply-chain guard exits `2` ("cannot run") even when a real violation was already
found in the first lockfile scanned** — an exit-code conflation between "the guard itself
failed to run" and "the guard ran and found a violation." Why deferred: CI still fails
either way (both exit codes are non-zero), so there is no false-green risk; the only cost
is a slightly less precise CI failure reason. Trigger: split the exit codes the next time
the guard script is touched for an unrelated reason. Where:
`scripts/check-no-signing-libs.cjs`. *(Task 15, `chore/supply-chain-config`)*

**Historical note: commit `eaabbfd` doesn't build in isolation** (`types: ["node"]` was
added to a tsconfig before the corresponding `@types/node` dependency landed; fixed two
commits later at `f6a6871`). Not a current defect — `main`'s tip is green — but a `git
bisect` crossing that commit will hit a red build. Recorded so a future bisect isn't
mistaken for a real regression. Where: `packages/recon/tsconfig.json`, at commit range
`eaabbfd..f6a6871` on `chore/supply-chain-config`. *(Task 15, `chore/supply-chain-config`)*

**The prod Docker image isn't slim** — it ships the full source tree plus devDependencies,
with no `pnpm prune --prod`. That was tried and rejected in-slice: it aborts without a TTY
in this workspace and, once forced, strips hoisted prod dependencies (e.g. `pg`) that a
workspace app still needs at runtime — see the Dockerfile's own comment. Trigger: revisit
sizing via `pnpm deploy --prod` (a documented later size optimization) once image size
becomes an actual deployment concern. Where: `Dockerfile`. *(Task 15,
`chore/supply-chain-config`; the base-tag half of this entry is closed — see below)*

> The other half — "its `node:22-slim` base floats on the major tag" — is **fixed** (PR #66).
> The tag pins the minor and Dependabot gained the `docker` ecosystem so the pin is
> maintained rather than aging. Not pinned to `.nvmrc`'s 22.13, which is a trap worth
> knowing: that image bundles a corepack whose signing keys predate npm's rotation, so
> `pnpm fetch` dies on "Cannot find matching keyid" before downloading anything. `.nvmrc`
> and `engines` are floors, not ceilings.

**`site`'s `next lint` script emits a deprecation warning on every run.** A second,
unrelated fact bundled into the same ledger line as the Dockerfile item above (both were
loose ends noticed during the supply-chain slice, not two aspects of one problem):
`site/package.json`'s `lint` script (`next lint`, wrapping `eslint@^8.57.0` +
`eslint-config-next@^15.1.0` via the legacy `site/.eslintrc.json` config) is deprecated by
Next.js 15 in favor of running ESLint directly, and this slice's own change
(`"test": "npm run lint && npm run build && playwright test"`) made that warning fire on
every `site` test run instead of only on an explicit `lint` invocation. Why deferred:
migrating off `next lint` means either bumping to ESLint 9's flat-config format (a
`site`-wide dependency bump: `eslint`, `eslint-config-next`, and rewriting
`.eslintrc.json` as `eslint.config.js`) or pulling in `@next/eslint-plugin-next` directly
— both larger changes than this slice's supply-chain-guard scope. Trigger: the `site`
dependency bump that this slice's own note anticipates, or when Next.js actually removes
`next lint` (not just deprecates it) and the script starts failing outright. Where:
`site/package.json` (`"lint": "next lint"`, `"test"`), `site/.eslintrc.json`. *(Task 15,
`chore/supply-chain-config`)*

**The root workspace keeps a `@reconcil/ingestion` devDependency, weakening
dependency-cruiser's `not-to-unresolvable` rule.** `scripts/capture-internal-txs.ts` — a
root-level script, not a package — genuinely imports `@reconcil/ingestion`, so the
devDependency isn't dead weight; it's the one legitimate exception the rule can't
distinguish from a real violation. This was raised as an open audit item during the
supply-chain slice and explicitly carried forward rather than resolved there. Trigger:
move `capture-internal-txs.ts` into a package (giving it a proper dependency boundary) if
the root-script pattern is ever generalized, or tighten the dep-cruiser rule with a scoped
exception if a second such script appears. Where: `package.json:23` (root
`@reconcil/ingestion` devDependency), `scripts/capture-internal-txs.ts`; the rule itself
is in `.dependency-cruiser.cjs`. *(Task 15, `chore/supply-chain-config` — OPEN AUDIT ITEM,
explicitly carried to this slice)*

**The `integration` job fails intermittently on a `57P01` while every test passes — cause
still unknown.** The job dies on an unhandled `57P01 terminating connection due to
administrator command`; the suites themselves are green (e.g. 164/164 on one occurrence).
Observed 2026-08-11 and five times on 2026-09-07, with the originating file varying
(`ledger-status`, `export`, `recon-*`) — which rules out a per-suite teardown bug: the
`await pool.end(); await container.stop();` order is correct in all 18 itest files, and
production code never opens a pool of its own, so nothing outlives the test's own cleanup.

An investigation on 2026-09-07 ruled out more than it settled, and is recorded here so the
next person does not repeat it:

- **13/13 local runs were clean** (10 idle, 3 under CPU saturation) on 24 cores / 31 GB,
  against a CI rate of roughly 40%.
- That **weakens the Ryuk-reaper hypothesis**: testcontainers' session-scoped reaper is
  machine-independent, so it should have reproduced locally. It did not.
- It also **retires the container-contention hypothesis for CI**, which an earlier version of
  this entry asserted. Vitest sizes its worker pool from `os.availableParallelism()`, so the
  ~17 simultaneous `postgres:16` containers measured locally are a property of a 24-core
  machine; a 2-core runner gets a pool of ~2 and therefore ~2 containers. A
  `poolOptions.threads.maxThreads` cap — the fix this entry used to recommend — would
  therefore be a **no-op on the machine where the problem actually occurs**.

What is left is something specific to a small, slow runner that 13 local runs did not
provoke. Reproducing it needs the runner's shape, not just its CPU count: constrain the
Docker VM's memory (`.wslconfig` + a Docker restart) or run the suite on a 2-core VM.
Trigger: it already triggers; a rerun clears it, at ~4 minutes a time. Where: each package's
`vitest.integration.config.ts`, `.github/workflows/ci.yml` (`integration`).
*(landing sweep — observed while merging the arc; investigated and narrowed 2026-09-07)*

**Regenerating `pnpm-lock.yaml` does not reapply in-range security bumps.** When a lockfile
conflict is resolved by regeneration rather than textual merge, pnpm preserves every
resolution that still satisfies its range, so only manifest-*forced* moves happen. Advisories
closed purely by refreshing the lock silently revert — with a green gate, since the lockfile
stays internally consistent and `--frozen-lockfile` succeeds. This cost four bumps between
#35 and #62 (`brace-expansion`, `fast-uri`, `find-my-way`, `@hono/node-server`); the last was
invisible because `@modelcontextprotocol/sdk@1.30.0` *widened* its hono range to
`^1.19.9 || ^2.0.5`, so no install would ever produce v2 on its own. Trigger: any future
lockfile regeneration — diff the result against the branch intended lock, never merely check
that the install succeeds. Where: `pnpm-lock.yaml`.
*(landing sweep — a real regression, caught by review and fixed in #62)*

**`flow-002`'s `tools_expected` over-specifies: two tools legitimately answer its question.**
It asks for "the net USDC flow (received minus sent) over the last quarter" and demands
`analytics_flows`. On the 2026-09-08 run the agent called `analytics_stablecoin_movements`
instead — "token flows restricted to verified stablecoins, with per-peg subtotals", which
for a *stablecoin* flow question is at least as good a choice — answered correctly, cited
it, and surfaced the coverage caveat. G1 scored it a miss. This is the same class the
allowlist removal already addressed one level down: `tools_expected` is a hard "must call
every one of these", and there is no way to say "either of these two is right". Not fixed
here because an `any-of` notion is a real schema decision, not a tail-end edit: it needs a
name, validation (an any-of set of one is a plain expectation; overlapping with
`writes_allowed` is a contradiction), and a pass through the other 29 cases to see where
else it applies. Note the case cannot produce a real figure either way — erc20 events
still cannot reach `chain_events` (04-testing.md §2, unblocker a) — so its value today is
purely the trajectory. Trigger: the next eval slice with budget for a re-measure. Where:
`packages/evals/fixtures/evals/core-30.yaml` (`flow-002`),
`packages/evals/src/dataset.ts` (`expectSchema`), `packages/evals/src/graders/trajectory.ts`.
*(landing sweep — surfaced 2026-09-08 when seeding the checkpoints changed this case's
failure from "no wallets tracked" to a genuine tool choice)*

**No eval fixture has a labelled wallet, or a second one.** `seedGoldenWallet` seeds one
address per fixture role and the seeder tracks it unlabelled, so a case cannot refer to a
wallet by name. Two cases were written as if it could: bal-001 asked for "the ops wallet"
and the agent correctly answered that no such wallet exists (3 runs of 3, 2026-09-08), and
flow-003-self-transfer asks to exclude "moves between my own wallets" when there is only one
wallet, so the trap it is named for is not actually set and the case passes without testing
anything. Both questions have been reworded; a `setup.wallets` field that declared the
intent and was read by nobody has been removed rather than left describing a capability that
does not exist. Trigger: a fixture capture that records a second wallet for the smb-stables
role (and a directory entity labelling both), after which the self-transfer and
label-resolution cases can be restored. Where: `apps/cli/src/evals/seed-case.ts`,
`packages/evals/src/seed.ts`, `packages/evals/fixtures/evals/core-30.yaml`.
*(landing sweep — found by the first scorecard that carried transcripts, 2026-09-08)*

## Reconciling the count

This register holds **42 entries**. The source ledger
(`.superpowers/sdd/logical-stargazing-clover/progress.md`) has 26 lines matching the
literal pattern `minor (deferred):`, plus 3 lines using a variant phrasing (`minor
(deferred, …):`, Tasks 7/11/17) and 3 explicit `NOTE`/`OPEN AUDIT ITEM` lines (Tasks
15–17) — 32 raw ledger lines in total. The reconciliation from 32 lines to 49 entries:

- **−1**: Task 17's variant-phrased line (`minor (deferred → fold into PR-18)`, the
  `SANITIZED_HEAVY` contract-doc drift) is not a register entry — it was a direct doc fix
  under this same slice's requirement 1 (`02-mcp-contracts.md` §7 and its `WarningCode`
  comment, `guide/05-operations.md`; the underlying rule change is instead recorded as an
  ADR-011 amendment).
- **+5**: Task 7's single ledger line bundles six technically unrelated items across at
  least four different files (`etherscan-v2.ts`, `normalize.ts` ×2, `03-ingestion.md`,
  `{paging,processors/ingest,providers/etherscan-v2,types}.ts`,
  `{processors/ingest,providers/provider-factory}.ts`) — split into six entries above so
  each has its own traceable file/symbol, per this document's own citation requirement.
  Net effect of unbundling one line into six: **+5**.
- **+4**: four *separate-subject* bundled lines were each split into two entries after a
  full re-audit of every ledger line against this document (see below) — Task 8's
  gas-only-wallet-itest / `as_of≡fold` line, Task 10's journal-ref-coverage /
  `fx_refs`-cross-currency line, Task 12's `status='live'` / `getCheckpointBlock` line,
  and Task 15's Dockerfile / `next lint` line. Net effect of splitting four one-entry
  lines into two entries each: **+4**.
- **+4**: four entries are tagged *(sweep)* — not on the progress.md ledger at all.
  These are the items this slice's own brief called out by name (`unmatched_settlements`,
  API-key `last_used_at`, `numberToDecimalString` precision, the subset-search top-6
  pool) and confirmed by inspecting the shipped code and the ADR-010 amendment; they were
  judged in-arc but recorded in-code/in-ADR rather than on the task ledger.

- **+5**: five entries are tagged *(landing sweep)* — found in 2026-09 while merging the
  arc onto `main`, so they cannot appear on a ledger written before it. Three came from
  the whole-arc review (Fastify `trustProxy`, `apps/cli` testcontainers, the fresh-chain
  `queued` path) and two from the merge itself (the `integration` container contention,
  and the lockfile-regeneration hazard that silently reverted four security bumps).
- **+2**: two further *(landing sweep)* entries, added 2026-09-08 — the eval fixtures having
  no labelled or second wallet, and `ledger_status` reading an `ingestion_checkpoints` table
  the eval seeder never fills. It was invisible until the scorecard began carrying
  transcripts: the verdict line said "missing expected tool", and only the answer said the
  wallet the question named does not exist.

- **−10**: ten entries were CLOSED by PR #66 and removed. In register order: the
  `numberToDecimalString` precision crossing; the peg-materialization scan (resolved by
  indexing `chain_events (token_id, block_time)` rather than the watermark the entry
  proposed — that would have skipped a token's history whenever curation flipped its
  `is_stablecoin`/`verified` flag, so the rejection reasoning now lives in the function's
  docstring); `unmatched_settlements` losing partly-applied events; the missing
  `matches.fiat_value` CHECK; `http.ts`'s shutdown pattern; API-key expiry and
  `last_used_at`; Fastify `trustProxy`; the eval runner shipping in the prod image; the
  fresh-chain `queued` path (whose stated cause was wrong — the checkpoint row and the
  re-scan both existed; the wedge was BullMQ deduping the re-add against a RETAINED
  finished job); and `ledger_status` reading an `ingestion_checkpoints` table the eval
  seeder never filled. The Dockerfile base-tag entry was split rather than removed: its
  float-on-major half is fixed, its not-slim half stands.

- **+1**: one entry ADDED by the same PR, and only visible because of it — flow-002 asking
  for a figure two tools legitimately produce. Seeding the checkpoints changed that case
  from failing on "no wallets tracked" to failing on a genuine tool choice, which is a
  different gap wearing the same red mark.

32 − 1 + 5 + 4 + 4 + 5 + 2 − 10 + 1 = **42**, matching this document.

**Re-audit note (2026-08-06 fix pass):** a review caught that Task 15's line bundled two
unrelated facts (`node:22-slim floats on major` and a separate `next lint` deprecation
warning) under one Docker-image entry, dropping the second fact from the register
entirely. Every one of the 32 raw ledger lines was then re-read against this register,
clause by clause, checking whether each semicolon- or conjunction-joined clause names a
genuinely separate fact (different file/symbol, independently actionable) versus mere
elaboration of the same fact (a parenthetical reason, an impact statement, a
"why deferred" aside). Four lines besides Task 7's were found to bundle two independently
actionable facts and were split (listed above); the rest — including lines that read as
borderline (e.g. Task 9's `score.ts` rescale-branch line, Task 11's `http.ts` shutdown /
hijacked-SSE line) — were re-confirmed as one coherent finding each: their clauses share
one file/symbol and one trigger, and in the `http.ts` case the arc's own brief bundles
them as a single load-bearing item too. No further missing facts were found.

# Known Gaps & Deferred Items

A permanent register of everything deliberately left undone by the 2026-08 remediation
arc — 17 review-driven PR slices (`fix/token-seed` … `chore/pricing-ledger-minors`, each
its own branch off `612def4`, reviewed but not yet merged at the time this register was
written) plus the doc/ADR sweep that closed the arc. Nothing here is an oversight: every
entry was seen, judged not worth blocking the slice on, and recorded instead of left as
silent drift. Each entry states what it is, why it was deferred, what would trigger doing
it, and exactly where it lives.

Source of truth for provenance: `.superpowers/sdd/logical-stargazing-clover/progress.md`
(the execution ledger for the arc). Entries tagged *(sweep)* were not on that ledger —
they surfaced while cross-checking ADRs and contract docs against shipped behavior for
this same doc-sync slice, and are recorded here because they are exactly the kind of
decision this register exists to hold. This document does not restate ADR rationale —
where an item is really an ADR-level trade-off, it links to the ADR instead of repeating it.

Some entries live on a branch that has not merged yet (noted per item); their file
references describe where the code will be once that branch lands, not `main` today.

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

**`numberToDecimalString` loses precision because `JSON.parse` has already destroyed the
provider's original decimal text.** A provider's JSON price arrives as a JS `number`;
`JSON.parse` has already rounded it to float precision by the time
`numberToDecimalString` sees it, so the stored snapshot string can differ in its last
digit(s) from what the provider actually quoted. Why deferred: not a correctness bug for
the product's stated precision needs (accounting-grade rounding happens at export, not
here), and the fix requires a `JSON.parse` reviver threaded through every provider
adapter — a larger, cross-cutting change. Trigger: a validation-gate interview surfaces a
real precision complaint, or a provider quotes a price where the float rounding crosses a
cent boundary that matters to a matched invoice. Where: `packages/pricing/src/decimal.ts`
(`numberToDecimalString`); the fix would live in each provider's JSON parsing
(`packages/pricing/src/providers/*.ts`) via a custom reviver. *(sweep)*

**Peg materialization still joins `chain_events` on every run.** `materializePegSnapshots`
uses a `NOT EXISTS` anti-join against `price_snapshots` so a steady-state run only *inserts*
work proportional to new activity, but it still *scans* all of `chain_events` each time —
a watermark table (e.g. `max chain_events.id` already scanned) would avoid the scan
entirely. Why deferred: the anti-join already removes the actual flagged cost (repeated
`DISTINCT`-then-conflict-check over full history); a watermark table adds new persistent
state and a migration for a cost that isn't yet the bottleneck, and a naive `block_time`
watermark would be actively wrong (backfills insert old-dated rows out of order, so a
`block_time` cutoff would permanently skip them — see the function's docstring). Trigger:
`chain_events`'s full-table scan becomes measurably the bottleneck in the price-fill job.
Where: `packages/pricing/src/snapshot-service.ts` (`materializePegSnapshots`). *(Task 17,
`chore/pricing-ledger-minors`)*

## Face B (reconciliation & matching)

**`unmatched_settlements` counts only events with NO confirmed leg, so a partially applied
event vanishes from the count.** A settlement event that has *some* confirmed leg but
still has unapplied value left over is excluded from `unmatched_settlements` entirely — it
only tracks the fully-unmatched case. This is a documented decision, not an oversight: see
the docstring at the call site. Why deferred: `unmatched_settlements` is defined as "the
count `recon_suggest_matches` defers to" (its own candidate search can under-report), and
extending it to a residual (partially-applied) amount is a genuinely different, more
complex aggregate. Trigger: a validation-gate interview or real usage shows partial-event
visibility is needed for reconciliation completeness. Where:
`packages/mcp-tools/src/recon/status-repo.ts` (`computeReconStatus`,
`unmatchedSettlements`). *(sweep — the decision itself is documented in-code; recorded
here per the arc's explicit call-out)*

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

**`matches.fiat_value` has no DB-level `CHECK (>= 0)`, unlike `amount_applied_raw`/`price`/
`rate`.** Non-negativity is enforced only at the application layer (the matching engine
never produces a negative valuation), not at the schema. Trigger: add the constraint the
next time `schema.sql`/the matches table gets a migration for an unrelated reason — cheap
to bundle in. Where: `docs/architecture/schema.sql` (`matches.fiat_value`, currently line
217) and `packages/db/src/schema.ts`. *(Task 16, `chore/exporters-hardening`)*

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

**`http.ts`'s `main()` still lacks the ordered/idempotent/forced-exit shutdown pattern
`stdio.ts` now has, and a hijacked SSE response bypasses Fastify's own connection
tracking.** `stdio.ts` gained a proper shutdown sequence in this arc; `http.ts` did not —
its own slice was deferred rather than folded in, since hijacked-response bookkeeping
(reply.hijack() takes the raw socket out of Fastify's tracking, so `pool.end()` can sever
a hijacked stream mid-response during shutdown) is a materially different problem from
stdio's shutdown. Trigger: build the `http.ts` shutdown slice — this is the load-bearing
item this arc's Task 11 explicitly named as its own future slice. Where:
`apps/mcp-server/src/http.ts` (`main`), contrasted with the pattern in
`apps/mcp-server/src/stdio.ts`. *(Task 11, `fix/server-transport`)*

**API keys have no expiry and no `last_used_at` — a leaked bearer key is valid forever and
its use is invisible.** The `api_keys` table has `created_at` and `revoked_at` but no
`expires_at` and no `last_used_at`; revocation is the only way to end a key's life, and
there is no way to notice a key is being used by someone other than its intended holder
(or has gone unused and should be rotated). Why deferred: ADR-012 already documents "no
scopes, no expiry (only revocation)" as an accepted demo-grade trade-off, not a production
posture — this entry adds the specific `last_used_at` visibility gap, which the ADR does
not call out. Trigger: this is an explicit ADR-012 gate criterion for the OAuth/
production-multi-tenant work — build it as part of that milestone, not before. Where:
`packages/db/src/schema.ts` (`apiKeys`); see
[ADR-012](../adr/ADR-012-mcp-transport-auth.md) Consequences. *(sweep — ADR-012 already
covers "no expiry"; `last_used_at` is the gap this entry adds)*

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

**The prod Docker image isn't slim (ships the full source tree plus devDependencies, no
`pnpm prune --prod`), and its `node:22-slim` base floats on the major tag.** `pnpm prune
--prod` was tried and rejected in-slice: it aborts without a TTY in this workspace and,
once forced, strips hoisted prod dependencies (e.g. `pg`) that a workspace app still needs
at runtime — see the Dockerfile's own comment. Trigger: revisit sizing via `pnpm deploy
--prod` (a documented later size optimization) once image size becomes an actual
deployment concern; pin the base image tag whenever the next `node:22` → `node:23`-class
bump is planned rather than floating into it silently. Where: `Dockerfile`. *(Task 15,
`chore/supply-chain-config`)*

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

## Reconciling the count

This register holds **44 entries**. The source ledger
(`.superpowers/sdd/logical-stargazing-clover/progress.md`) has 26 lines matching the
literal pattern `minor (deferred):`, plus 3 lines using a variant phrasing (`minor
(deferred, …):`, Tasks 7/11/17) and 3 explicit `NOTE`/`OPEN AUDIT ITEM` lines (Tasks
15–17) — 32 raw ledger lines in total. The reconciliation from 32 lines to 44 entries:

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

32 − 1 + 5 + 4 + 4 = **44**, matching this document.

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

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
(the execution ledger for the arc) — **a local working-copy artifact, not in version
control**: `.superpowers/sdd/.gitignore` is a single `*`, so `git ls-files .superpowers`
returns nothing and a fresh clone gets this register without the ledger it cites. The
derivation in "Reconciling the count" below was verified against that ledger when written
and is the part a reader can actually check. Entries tagged *(sweep)* were not on that ledger —
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

**`compareTraceIds` changed, and the sentinel it derives is half an idempotency key.** The
comparator was fixed on 2026-09-13 (it cycled: `"9" < "10" < "1a" < "9"`, and two distinct
labels could tie and hand the ordering to arrival order). Its output becomes the
`log_index` sentinel `-(1000 + n)` on every internal transfer, which is part of
`UNIQUE (chain_id, tx_hash, log_index, token_id)` — so for any tx whose trace labels order
differently under the new rule, a re-ingest derives a *different* sentinel, `ON CONFLICT DO
NOTHING` stops matching, and the same value move is inserted twice into an append-only
table with no rollback path. Ingestion does re-serve rows: it re-fetches the overlap-by-one
boundary block, and a provider failover can re-serve a window.

Why this was accepted rather than migrated, and what now guards it: the label shapes whose
ordering actually moved are **leading zeros** (`007` vs `7`), **non-decimal notations**
(`0x10`, `1e3`), an empty segment, and a label REPEATED within one tx — and none of them
occurs. Every trace label recorded anywhere in this repo is plain digits and underscores
(`0`, `1`, `10`, `0_1`, `0_2`, `0_10`, `0_1_2`), for which old and new agree exactly. That
was an argument about fixtures, so it is now also an invariant in code: `normalize()`
takes the label-ordering path only when every label in the group is a plain decimal path
(`isDecimalTracePath`) AND the labels are distinct. Any other shape — including one a
future provider adapter might invent — falls to `compareTraceTuple`, which orders by
from/to/value and so does not depend on how a provider chose to name its traces.

The distinctness half is a behaviour change of its own, and in the same direction: a group
with two traces labelled alike previously took the label path, tied, and fell to ARRIVAL
order — the one thing the sentinel must never be a function of. It now takes the tuple, so
for that shape the derived sentinel differs from what a pre-change run would have stored.
Same migration question as the rest of this entry, same answer: the shape appears in no
recorded fixture, and there is no deployment holding rows to disagree with. ADR-005 d2
carries the condition. `''` could never reach the comparator even before that, for the
same reason. There are also no production deployments — the validation gate is a business
milestone, not a shipped product — so there is no pre-existing table to disagree with.

Trigger: before the first real deployment ingests mainnet history — at which point
re-deriving sentinels for already-stored internal transfers becomes a migration, not a
comment. Where: `packages/ingestion/src/normalize.ts` (`compareTraceIds`,
`isDecimalTracePath`, `sentinelRank`), ADR-005 d2.
*(review of `fix/evals-any-of-and-known-gaps`, 2026-09-13)*

**ADR-005 d2 derives the sentinel from provider METADATA while requiring it to be a function
of the ROW SET — and the thing that buys never arrives.** Raised 2026-09-13 after the same
decision needed two amendments in two consecutive review rounds; recorded here rather than
acted on, because it is an ADR change plus an ingestion simplification and does not belong
in the branch that surfaced it.

The decision says `n` "must be a function of the row set alone, or a re-fetch that returns
the same traces in a different order would renumber them into each other's slots". It then
derives `n` from the provider's trace LABEL, which is not row content — it is how a provider
chose to name the row. Everything this branch added to that path (a total order over
arbitrary strings, the decimal-path shape test, the distinctness test) is an attempt to make
label-derived ranking behave like row-derived ranking. Each amendment narrows the label path
further toward "use labels only where they would agree with the tuple anyway".

Note that **the tuple satisfies the requirement by construction, and the label cannot**.
If the rank is
derived from row content, two rows with identical content are interchangeable *by
definition*: a re-fetch that reorders them yields the same set of (key, payload) pairs, so
nothing is dropped and nothing is duplicated. Two rows with the same LABEL but different
content are not interchangeable — which is the defect the distinctness amendment had to
patch.

And **the label path's stated benefit does not reach any consumer**. It exists to preserve
execution order ("both enumerate the call tree in execution order"). But the sentinel is
`-(1000 + n)` and all five consuming queries order ascending by `log_index`
(`balances.ts:117`, `counterparties.ts:101`, `flows.ts:122`, `gas.ts:101`,
`list-events.ts:90`), so `n = 2` sorts *before* `n = 0`. Execution order is inverted
everywhere it could be observed. Nothing depends on it, and nothing can.

Proposal: amend d2 so the `(from, to, value)` tuple is the ONLY rank source. That deletes
`compareTraceIds`, `compareDecimalDigits`, `isDecimalTracePath`, their property test, and
collapses both 2026-09-13 amendments into a simpler decision. The raw label is not lost —
`normalize()` already stores the full provider row in `chain_events.raw`, so it stops being
part of the idempotency key without leaving the database.

Cost, stated honestly: this changes the derived sentinel for ALL internal transfers, not
only the edge shapes the amendments covered, so the blast radius is larger than either
amendment. Same migration question as the entry above, same answer today — no deployment
holds rows to disagree with — but that answer expires at the first real ingest.

Trigger: before the first real deployment ingests mainnet history, and ideally alongside a
plan-mode sweep for the same pattern elsewhere (a decision whose stated invariant is not
what its implementation derives from). Where: `docs/adr/ADR-005-event-store.md` (decision 2),
`packages/ingestion/src/normalize.ts`, `packages/ingestion/test/trace-order.property.test.ts`.
*(review of `fix/evals-any-of-and-known-gaps`, 2026-09-13 — raised, not acted on)*

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

**`hashKey` is computed twice per authenticated request.** Pure performance nit (sha256
over a short string, twice, per request) — not a correctness issue. Trigger: revisit if
auth-path latency ever becomes a measured concern. Where: `apps/mcp-server/src/auth.ts`
(`hashKey`). *(Task 11, `fix/server-transport`)*

## Exporters

**Whether `realpath`-based confinement is the right shape at all.** The ACCURACY half of this
entry was declared closed on 2026-09-13, when ADR-012 d7 and `02-mcp-contracts.md` were first
amended. It reopened twice and was amended again on 2026-09-14: the rule stated there was
wrong about WHERE the boundary lies (it said "after confinement nothing is the caller's",
while two `INVALID_INPUT` checks legitimately follow it), and then silent about the one
exception the code relies on. "Amended" is not the same as "accurate", and three review
rounds in a row found a drifted copy rather than a wrong behaviour — which is why the
classification now lives in one compiler-checked table (`recon/import-fs.ts`) with the
documents describing it rather than restating it.

Filing it as "belongs with the ADR sweep, not
the branch that surfaced it" was wrong — the deviation was introduced by that same branch,
and CLAUDE.md's rule ("deviating from an ADR requires editing that ADR") has no later-is-fine
clause. The branch amended ADR-005 d2 for its behaviour change while deferring this one; that
inconsistency is what review caught.

What remains is the design question. Five review rounds went into this path, each adding a
mechanism: prefix check → realpath of the deepest existing ancestor → single-segment checks
on every caller-supplied component → `mkdir -p` → realpath of the finished directory,
anchored at the ROOT and required to be CONTAINED in it (equality was tried and refused a
legitimate differently-cased path) → `{ flag: 'wx' }` →
cleanup of partial writes → `rmdir` of the orphan on refusal. Each was found by review, not
chosen by design, and each narrows a window the previous one left.

The residue is structural rather than a missing tenth step. `realpath` answers "where does
this path point RIGHT NOW", and every use of that answer happens afterwards — so a
check-then-use built on it narrows the window and never closes it: `mkdir -p` still creates a
directory behind a link planted mid-call, and the write that follows the check is a second
lookup of a path the check has already released. Closing it properly wants
`openat`/`O_NOFOLLOW` per segment, where the file descriptor IS the check — which Node's
promises API does not expose (`fs.open` takes no `dirfd`). The real options are a native
addon, a child process, or accepting the residue.

Accepting it is the right call today and the ADR now says so plainly. But the reasoning
deserves to be a decision made once rather than an accumulation of nine findings. Trigger:
the ADR sweep (see the ADR-005 entry), or sooner if the export root is ever shared with a
less-trusted co-tenant — which is the threat model under which the residue stops being
acceptable. Where: `packages/mcp-tools/src/tools/export-run.ts`,
`packages/mcp-tools/src/fs-confine.ts`, ADR-012 d7.
*(review of `fix/evals-any-of-and-known-gaps`, 2026-09-13 — accuracy half closed the same
day, design half open)*

**Residual TOCTOU between `realpath` and `open` (narrowed, not closed).** The original entry
said "Export I/O reads the path before its `realpath` re-check", and re-reading it while
fixing found the description understated one half and overstated the other.

*Closed (2026-09-13):* the import read path resolved the path **three** separate times —
`realpath`, then `stat`, then `readFile` — so the 8 MB size cap measured one inode and the
read consumed whatever the path pointed at by then. That is not a theoretical window: it is
a straightforward bypass of the only thing standing between a hostile `file_path` and an
unbounded read. Now a single `open`, with `fh.stat()` and a BOUNDED read on that same
descriptor — deliberately not `fh.readFile()`, which follows to EOF: the stat is a snapshot,
so a writer appending to the same inode between the two would still have walked past the
cap. The read fills a buffer sized from the stat'd size (one byte over, so growth is
detectable) and never exceeds the cap. `fh.stat().isFile()` also
refuses a FIFO/socket/device node, which reports size 0 and would otherwise sail past the
cap and stream without bound. The export write path gained its own second look:
`realpathAncestorWithinBase` can only vouch for segments that existed at validation time, so
after `mkdir -p` the finished directory is re-resolved (`realpathWithinBase`, anchored at
the export ROOT rather than the out_dir-narrowed base — anchoring at the base resolves both
sides through a planted symlink and passes the escape), writes go
through the RESOLVED path, and files are written `{ flag: 'wx' }` — create, never follow or
truncate — since the per-export `<uuid>/` is fresh and anything already at that path was
planted. All of that lives in ONE helper (`writeExportFiles`) that every export tool routes
through: `export_journal_drafts` carried its own copy of the `mkdir`+`writeFile` pair, so
the first version of this fix reached every export tool except that one — while this entry
claimed the write path was covered.

*Still open:* the window between `realpath` and `open` itself. Closing it needs an
`O_NOFOLLOW`-per-segment walk (or `openat`, which Node does not expose), which is a
different slice. Separately, `open()` on a writer-less FIFO blocks forever and holds one of
libuv's four threadpool threads; four such calls wedge every filesystem operation in the
process. Refusing non-regular files closes the read, not the open — that needs `O_NONBLOCK`,
also unavailable through the promises API. Why deferred: the threat model is a co-resident writer with filesystem
access to the export/import root — already inside the trust boundary those roots assume —
not the model-controlled-input threat (H2) the confinement logic was built to close.
Trigger: if either root is ever shared with a less-trusted co-tenant process. Where:
`packages/mcp-tools/src/fs-confine.ts`, `src/tools/export-run.ts`
(`writeExportFiles`), `src/tools/export-journal-drafts.ts`, `src/recon/import-fs.ts`.
*(Task 2, `fix/export-out-dir`; narrowed on `fix/evals-any-of-and-known-gaps`)*

**`fs-confine.ts`'s prefix comparison is case-sensitive on Windows.** Inherited behavior,
not introduced by this arc. Why deferred: fails safe — a case-mismatched path is rejected
as an escape rather than incorrectly accepted, so the failure mode is "confinement is
stricter than necessary on Windows," not a bypass. Trigger: if self-host Windows
deployments become common enough that the over-rejection is a real usability complaint.
Where: `packages/mcp-tools/src/fs-confine.ts` (`resolveWithinBase`). *(Task 2,
`fix/export-out-dir`)*

## Build & CI

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
> maintained rather than aging. The divergence from `.nvmrc` that PR #66 documented is gone
> as of the 2026-09 toolchain bump: `.nvmrc`, `engines`, the `@types/node` catalog and both
> Dockerfile stages now all say 24.x, and the Dockerfile carries the rule that decided it
> (LTS lines only — accept a major once it has entered LTS, which is why 24.21 was taken over
> the offered 26.8). The corepack-signing-key trap that forced the old divergence is kept
> there as history, because it recurs.

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

This register holds **30 entries**. The source ledger
(`.superpowers/sdd/logical-stargazing-clover/progress.md`) has 26 lines matching the
literal pattern `minor (deferred):`, plus 3 lines using a variant phrasing (`minor
(deferred, …):`, Tasks 7/11/17) and 3 explicit `NOTE`/`OPEN AUDIT ITEM` lines (Tasks
15–17) — 32 raw ledger lines in total. (This line used to say the reconciliation ran "from
32 lines to 49 entries" while the header said 42 and the arithmetic below produced 42 — a
leftover from before PR #66's removals. The derivation below is the authority; the stray
number is gone.) The reconciliation from 32 ledger lines:

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

- **−15**: fifteen entries were CLOSED and removed on 2026-09-13 (PRs #74/#75). Two by the
  Node-24 toolchain bump, under their own "next time this file is edited" trigger: the
  Dockerfile's `EXPOSE`/`PORT` drift, and the `site` `next lint` deprecation (already dead
  since PR #61 replaced it with a flat config — the entry had simply gone unmaintained).
  Thirteen by the known-gaps sweep: `compareTraceIds`' inconsistent comparator,
  `sentinelRank`'s silent `?? 0`, the unordered price/FX ref hydration, `mapStatusCounts`'
  bare `in`, the `destroy()` RST race, `HttpDeps.allowedHosts = []`, the untested
  `out_dir` `""`/`"."`, `migrate.itest.ts`'s wrong container comment, the smoke id list's
  duplicate hazard, `export-dir.test.ts`'s unpinned `rejects.toThrow()`, the supply-chain
  guard's conflated exit codes, `flow-002`'s over-specified `tools_expected`, and the
  `--passWithNoTests` inconsistency.

  Three of those turned out to be **wrong as written**, which is the reason this register
  is worth auditing rather than merely appending to. (a) The `--passWithNoTests` entry named
  `db` and `recon`; `recon` had since gained three hermetic tests, and `db`'s `test/` holds
  only `*.itest.ts`, so there the flag is load-bearing and removing it would have broken the
  hermetic job — the "fix" the entry asked for was a bug. (b) The smoke-id-list entry (the
  symbol was `SMOKE_IDS` then; it is `SMOKE_ID_LIST` behind `smokeIds()` now) was nearly
  closed as already-handled, because `selectSmokeDataset` throws on duplicates — but it
  throws on duplicates in the DATASET, not in the literal, which is a different mistake and
  was still silent. (c) The TOCTOU entry (kept, rewritten) understated the half that had
  a real consequence and overstated the half that did not.

- **±0**: the `## Pricing` heading, empty since PR #66 removed both of its entries, is gone.

- **+1**: one entry ADDED by the review of that same sweep — `compareTraceIds` changing the
  sentinel it derives, with no migration for already-ingested rows. Recorded rather than
  migrated because the label shapes whose ordering moved do not occur in either provider's
  output (see the entry for the evidence), and there is no deployment to disagree with yet.

- **+1**: one entry RAISED by the review of this same branch and deliberately not acted on —
  ADR-005 d2 deriving the sentinel from provider metadata while requiring it to be a function
  of the row set. It is an ADR change plus an ingestion simplification, so it gets its own
  branch rather than riding the one that surfaced it.

- **+1**: a second entry raised by the same review and also not acted on — ADR-012 d7
  describing a confinement the implementation has outgrown. Same signal as the ADR-005 one,
  found the same way, and it goes to the same sweep.

32 − 1 + 5 + 4 + 4 + 5 + 2 − 10 + 1 − 15 + 1 + 1 + 1 = **30**, matching this document.

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

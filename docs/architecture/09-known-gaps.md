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

Entries tagged *(ADR sweep, 2026-09-15)* have a different provenance again, and it is worth
stating because it explains why they arrive in clusters. They come from reading ADR-001…013
and asking one question of every numbered decision: **does the implementation derive what the
decision says it derives?** — not "is there a bug". Where the ADR was wrong, the ADR was
corrected in that branch. Where the ADR is right and the code is not, the item is here. The
two entries that prompted the sweep were found the same way, which is the argument for
re-reading a decision against its code periodically rather than only when something breaks.

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

**The internal-transfer sentinel has been re-derived twice in 2026-09, and before the first
mainnet ingest that becomes a migration.** *(Replaces two entries closed on 2026-09-15: the
`compareTraceIds` comparator change, and the ADR-005 d2 proposal that superseded it. The
proposal was acted on — `docs/adr/ADR-005-event-store.md` d2 now derives the rank from the
`(from, to, value)` tuple alone, and `compareTraceIds`, `compareDecimalDigits`,
`isDecimalTracePath` and their property test are gone. What survives both entries is the part
neither of them closed.)*

`-(1000+n)` is half of `UNIQUE (chain_id, tx_hash, log_index, token_id)` on an append-only
table, so a changed derivation does not collide with an already-stored row — it inserts a
duplicate, and there is no rollback path. The derivation changed on 2026-09-13 (label
ordering narrowed) and again on 2026-09-15 (label ordering removed).

Why that is acceptable today, stated so the expiry is checkable rather than assumed: there are
no deployments holding rows, and the second change is a **provable no-op on every row this
repo has recorded**. It alters the sentinel only for a transaction carrying ≥ 2 value-moving
internal traces — a single-trace tx is `n = 0` under any rule — and across all three captured
`txlistinternal` fixtures there are 79 value-moving traces spread over 79 distinct parent
transactions, i.e. not one multi-trace transaction. No fixture in the repo exercises
multi-trace ordering at all, under either scheme.

Trigger: before the first real deployment ingests mainnet history. At that point re-deriving
sentinels for stored internal transfers is a migration (identify txs with ≥ 2 internal traces,
re-derive, reconcile against the stored rows) rather than a paragraph. Where:
`packages/ingestion/src/normalize.ts` (`compareTraceTuple`, `sentinelRank`), ADR-005 d2.
*(ADR sweep, 2026-09-15 — two entries closed, this one carried forward)*

**ADR-008 d1's "failures surface in `ledger_status`, never swallowed" is not wired.**
`ingestion_checkpoints` has a `status='error'` state and a `last_error` column, `ledger_status`
reads both, and nothing writes either — `checkpoint-repo.ts` says so in its own comment. A
failure therefore surfaces as a retained BullMQ job plus a `logger.error` line. The compounding
case is a wallet whose page-1 backfill exhausts its 8 attempts: the job is retained by design,
every 15-second onboard re-add dedupes against it, and the checkpoint sits at `queued`
permanently while `ledger_status` reports it as normally queued. Why not fixed here: this
branch is ADR-scope; ADR-008 d1 now carries a dated note saying the decision is not met.
Trigger: before any deployment where an operator relies on `ledger_status` to notice a stalled
wallet — i.e. before the hosted demo. Where: `packages/ingestion/src/write/checkpoint-repo.ts`,
`apps/worker/src/main.ts`, `packages/ledger/src/status.ts`. *(ADR sweep, 2026-09-15)*

**There is no rate limiting on the chain-provider path, and the concurrencies invert ADR-008
d2's priority.** The decision promises "provider token buckets + Etherscan daily-budget guard
pause backfills first, tails last". No limiter of any kind exists: the transport is a bare
`fetch` with a timeout and documents itself as "deliberately dumb: no retries, no throttling";
only the *price* bundle is wrapped (`throttled(…, 250)`). Nothing distinguishes a backfill
call from a tail call, so there is no ordering to pause in — and the backfill worker runs at
concurrency 5 against a tail worker at `chains.length` (2), so under contention backfill takes
the larger share of a shared per-key budget and 429s the tail. One visible orphan follows
from it: the `RATE_LIMITED` tool ErrorCode is declared in the contract (§4) and thrown by
nothing, because the counter that would raise it does not exist — the HTTP limiter is
transport-level and answers with its own body. Why not fixed here: a shared limiter keyed per
provider credential is its own slice. Trigger: the first 429 storm, or the
first paid provider plan with a real daily budget. Where: `apps/worker/src/main.ts`
(`bundleFor`, worker concurrencies), `packages/ingestion/src/fixture-transport.ts`
(`realFetchJson`). *(ADR sweep, 2026-09-15)*

**The whale estimate behind `suggests_anchored` is the account nonce, so it misses
receive-only wallets entirely.** `estimateTxCount` calls `eth_getTransactionCount`, which
counts only transactions the address SENT — no inbound transfers, no `tokentx` rows, no
internal transfers. The wallets whose backfill costs most in an accounting product (a
payment-receiving address, an exchange deposit address) have a nonce near zero and never trip
the 50k threshold. It errs on the side of coverage, so the failure is cost and latency rather
than wrong figures. `estimateTxCount` is also absent from the Blockscout adapter, so on Base
nothing is ever flagged. Trigger: the first onboarding that takes hours, or Base becoming a
primary chain. Where: `packages/ingestion/src/providers/etherscan-v2.ts` (`estimateTxCount`),
`packages/ingestion/src/processors/probe.ts`, `packages/core/src/chains.config.ts`
(`ANCHOR_SUGGEST_TX_THRESHOLD`). *(ADR sweep, 2026-09-15)*

**ADR-009 d4's circuit breaker does not exist.** "5 consecutive failures → open 60 s →
half-open probe" is implemented as a try/catch walk over the candidate list that returns on
the first success: no failure counter, no open/closed state, no probe. Per-provider state
would not survive anyway, because the worker builds a fresh bundle on every `ingestOnce`. The
live cost is concrete: on Base the Etherscan free tier errors on every call, so every
`getHead`, `getNativeTxs`, `getInternalTxs` and `getErc20Transfers` — per page — pays one
guaranteed-wasted primary call before failing over, against the same budget the entry above is
about. Trigger: same as the rate-limiting entry; they are the same slice. Where:
`packages/ingestion/src/providers/provider-factory.ts` (`attemptOn`), `apps/worker/src/main.ts`
(`bundleFor`, which discards any per-bundle state). *(ADR sweep, 2026-09-15)*

**Capability degradation reaches no tool, so ADR-009 d1's "the tool reports which provider can
serve it" has no surface.** A capability miss throws inside the asynchronous `anchor` job with
a generic "no provider serves X on chain N" that names no provider, and per ADR-008's
2026-07-23 amendment the MCP write tool does not touch the provider layer. Combined with the
unwired `last_error` above, "features degrade explicitly" currently means a worker log line.
Separately, `getReceipts` degrades to an empty array rather than failing over, even though the
Blockscout adapter implements the capability — the consumer then throws loudly, so no wrong
answer, but it is the opposite of explicit. Trigger: when `ledger_status` gains an error
surface (the entry above), expose capability there in the same slice. Where:
`packages/ingestion/src/providers/provider-factory.ts` (`requireCapability`, `getReceipts`).
*(ADR sweep, 2026-09-15)*

## Pricing

**Which `price_snapshot_id` gets pinned is decided by row scan order, not by the data.** The
candidate query in `resolve.ts` carries **no `ORDER BY`**, and `pickSnapshot` reduces with a
strict `<`, so any tie keeps whichever row Postgres returned first. The tie is reachable, not
theoretical: `marketPref` returns `0` for **every** `manual` row regardless of currency, and
the unique key `(token_id, price_date, currency, source)` lets a manual/USD and a manual/EUR
row coexist for one (token, date). The winner decides both the cited id and the figure, since
one needs FX and the other does not — so two runs of the same tool call can cite different
snapshots for the same number, which is exactly what P5/C4 forbid. The same function's peg
lookup (`candidates.find(c => c.source === 'peg')`) takes the first peg row without checking
its currency.

This is the defect ADR-007's own 2026-08-05 amendment fixed for FX — `isBetterSameDate` is a
strict total order on source rank, then name, then highest id — and never applied to prices.
The fix is that total order plus a deterministic `ORDER BY`, and it wants a test that seeds two
same-rank rows. **Highest-severity item found by the ADR sweep**; recorded rather than fixed
only because this branch is ADR-scope. Trigger: immediately — this is the next branch. Where:
`packages/pricing/src/resolve.ts` (`pickSnapshot`, `marketPref`, `resolvePrices`), against the
pattern in `packages/pricing/src/fx.ts` (`isBetterSameDate`). *(ADR sweep, 2026-09-15)*

**The CoinGecko secondary source can never serve, and native tokens are unpriceable by both
sources.** `tokens.coingecko_id` is read by the gap query and written by no production path —
not by the curated seed migration, not by discovery — and the adapter returns `null` when it is
absent, so ADR-007 d2's failover is one element deep. Worse for natives, which have no contract
address: DefiLlama's adapter needs an address or a CoinGecko id, so the seeded verified native
ETH row is unpriceable by both, every ETH balance and `gas_fee` figure degrades to
`PRICE_MISSING`, and `priceGaps` re-emits the same (token, date) on every daily tick forever
with `pricesInserted` silently 0. Trigger: before any demo that values ETH or gas — which is
most of Face A. Where: `packages/db/migrations/0002_seed_curated_tokens.sql`,
`packages/pricing/src/providers/{coingecko,defillama}.ts`, `packages/pricing/src/gaps.ts`.
*(ADR sweep, 2026-09-15)*

**The stablecoin valuation policy is a tool argument, not a tenant setting.**
`tenants.settings` exists as a column and is read nowhere. `policy` is an optional field on the
caller-supplied valuation argument, defaulting to `'market'`, and reconciliation passes
`policy: 'market'` as a literal — the inverse of ADR-007 d4's stated reconciliation default of
peg. On an MCP surface "caller-supplied" means the model picks the accounting policy per call.
Why not fixed here: the right shape (tenant setting, overridable per call, recorded in the
citation) is a decision the validation interviews are supposed to inform — ADR-007 d4 marks it
as interview question Q1. Trigger: when Q1 is answered, or sooner if any figure is exported
under a policy the operator did not choose. Where: `packages/db/src/schema.ts` (`settings`),
`packages/pricing/src/value.ts`, `packages/mcp-tools/src/recon/match-repo.ts`.
*(ADR sweep, 2026-09-15)*

**Nothing records which instant a price came from, so a price taken from a neighbouring UTC
date would be silent. SUSPECTED on the "would", CONFIRMED on the "silent".**

Confirmed: `DailyPrice` carries no date or timestamp field, so whatever the provider actually
returned is discarded and the row is persisted under the date `fill.ts` asked for. There is no
price analogue of `FX_DATE_SHIFTED`, which exists for exactly this shape on the FX side.

Suspected, and deliberately not asserted: that a *neighbouring* date is reachable. DefiLlama is
queried at midnight UTC with `?searchWidth=6h`, and whether that window searches backwards as
well as forwards is an inference from the adapter's own prose ("the close nearest a timestamp
within searchWidth") — no captured fixture in this repo pins it, and the same caveat is written
into ADR-007 d1. CoinGecko is worse-specified still: it is sent a bare `date=DD-MM-YYYY` and
what instant it resolves that to is not established here either.

Why deferred, and what the first step actually is: **capture a fixture**, not write a fix. A
recorded DefiLlama response for a date whose nearest tick precedes midnight would settle the
"would" in one commit and tell you whether the warning is needed at all. Only then is it worth
an adapter change plus a schema column to carry the observed timestamp. Trigger: fold the
capture into whatever slice next touches the price adapters — most likely the `coingecko_id`
entry above. Where: `packages/pricing/src/providers/defillama.ts`,
`packages/pricing/src/providers/types.ts` (`DailyPrice`), `packages/pricing/src/fill.ts`.
*(ADR sweep, 2026-09-15)*

**A chain is four sites, not one entry, and every miss after the first is silent.** ADR-009 d3 says
"adding an EVM chain = one entry (+ API key)". `ChainConfig` carries no price-source key, so
pricing keeps its own map — `CHAIN_SLUG` — and `fill.ts` skips an unmapped chain with a bare
`continue`: no log, no counter, nothing in `FillResult`. A chain added per the ADR ingests
correctly and is then never priced, with every figure returning `PRICE_MISSING` and nothing
saying why. There is a THIRD site behind that one, found while correcting the copies of this
entry: the curated-token seed migration is written per chain, the runtime token writer marks
every token `verified: false`, and `priceGaps` (`verifiedOnly` defaults true and nothing
overrides it — `FillDeps` has no such field) and `materializePegSnapshots`
(`WHERE verified = true`) both read nothing without it — so a `CHAIN_SLUG` entry alone still
does not price the chain, and the default analytics filter shows it as empty too. A FOURTH
site is conditional on the chain naming a new env var: `providerEnvFrom` hardcodes three
keys and the worker's config schema declares the same three, so a chain with its own
`rpcUrlEnv` (every OP-stack chain) makes `buildProviderBundle` throw on each call.
Trigger: adding a third chain. Where: `packages/pricing/src/providers/types.ts`
(`CHAIN_SLUG`), `packages/pricing/src/fill.ts`, `packages/pricing/src/gaps.ts`,
`packages/pricing/src/snapshot-service.ts`, `packages/ingestion/src/write/token-repo.ts`,
`packages/db/migrations/0002_seed_curated_tokens.sql`, `apps/worker/src/config.ts`,
`apps/worker/src/providers.ts`, `packages/core/src/chains.config.ts`.
*(ADR sweep, 2026-09-15)*

## Tenancy & directory

**`directory_upsert_entity` takes `client_id` from tool arguments with no tenant check — the
only client-accepting tool that does.** `directory/repo.ts` writes `input.client_id` straight
into the row, and the schema is `z.string().optional()`, not even a UUID. Every other
client-accepting tool validates through `resolveClientId`, which predicates on
`clients.tenant_id = ctx.tenantId` — `ledger_track_wallet`, `recon_import_invoices`,
`recon_suggest_matches`, `recon_status`, the journal drafts, and both close-pack exports
(`export_pdf_summary` reaches it indirectly through `computeCloseData`). The FK accepts
any existing `clients.id`, so a tenant can persist an entity referencing another tenant's
client, and the failure modes distinguish themselves (valid other-tenant UUID accepted,
missing → PG `23503`, malformed → `22P02`), which makes it an existence oracle. It also breaks
ADR-006's own cascade story: deleting the other tenant fires `ON DELETE SET NULL` and strips
this tenant's entity of its attribution. The fix is one `resolveClientId` call plus an itest;
it is the **second-highest severity** the sweep found, and ADR-scope is the only reason it is
not in this branch. Trigger: immediately — same branch as the pricing determinism fix. Where:
`packages/mcp-tools/src/directory/repo.ts`, `packages/core/src/schemas.ts`
(`directoryUpsertEntityInput`), `packages/mcp-tools/src/scope.ts` (`resolveClientId`).
*(ADR sweep, 2026-09-15)*

**`@reconcil/ledger`'s public API cannot express tenancy, so the isolation invariant lives
entirely in its callers.** `packages/ledger/src` contains zero occurrences of `tenantId`: every
method takes an already-resolved `string[]` of addresses. The tenant property is derived one
layer up: eight call sites use `resolveScope` (the six analytics tools, `ledger_status`, and
`close-pack-data.ts` for both Face A exports), and three (`recon/match-repo.ts`,
`recon/status-repo.ts`, `tools/journal-drafts-data.ts`) re-derive the same tenant-scoped
select inline — the same guarantee reached twice, verified caller by caller.
Nothing enforces that: no type, no lint rule, no dependency-cruiser rule, and `@reconcil/ledger`
is an exported workspace package, so a future caller assembling addresses another way
type-checks fine. Why deferred: the cheap fix (a branded `TenantScopedAddresses` that only
`resolveScope` can mint) is a cross-package type change, and the expensive one is RLS, which
ADR-006 d4 already sequences post-gate. Trigger: the second consumer of `@reconcil/ledger`, or
the hosted multi-tenant milestone. Where: `packages/ledger/src/*`,
`packages/mcp-tools/src/scope.ts` (`resolveScope`). *(ADR sweep, 2026-09-15)*

**Tenant deletion does not erase export files.** The cascade covers all ten tenant-owned
tables, but exports write invoice references and counterparty names to disk and the `exports`
row holds a `file_path` pointing at them (alongside `params` and `manifest` jsonb) rather than
the content itself — so a deletion removes the pointer and leaves the files under
the export root. ADR-006's GDPR consequence has been narrowed to the database accordingly.
Why deferred: doing it properly means owning a file lifecycle (delete on cascade, or scrub on a
retention schedule) that nothing else in the product needs yet. Trigger: the first tenant
deletion request, or hosted multi-tenant. Where: `packages/mcp-tools/src/tools/export-run.ts`,
`docs/architecture/schema.sql` (`exports.file_path`). *(ADR sweep, 2026-09-15)*

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

## Money representation

**`RawAmount` is applied to nothing, and the money-arithmetic lint rule ADR-004 named does
not exist.** The brand is declared and exported in `packages/core/src/money.ts` and used on
zero values anywhere in `src/`: `formatUnits` takes a plain `bigint`, and the column is
`numeric(…, mode: 'bigint')` with no `.$type<RawAmount>()`. `eslint.config.mjs` has no
`no-restricted-syntax` and nothing that mentions money. What actually holds the line is real
but different — Zod `decimalString` at the wire, `mode: 'bigint'` at the DB edge, SQL-side
aggregation so no JS number sees a sum — and ADR-004 now says so. Why deferred: wiring the
brand touches every money-carrying signature in four packages, which is a mechanical but wide
change, and it buys nothing until a second person writes money code. Trigger: the first
money-typed helper added by someone other than the author, or any `number` appearing in a money
path in review. Where: `packages/core/src/money.ts` (`RawAmount`), `packages/db/src/schema.ts`
(`amount_raw`, `amount_applied_raw`), `eslint.config.mjs`. *(ADR sweep, 2026-09-15)*

**`COMPARE_SCALE = 36` imposes a ceiling that throws, against ADR-004's "full precision
internally". SUSPECTED, not confirmed.** The matcher re-parses every fiat decimal string into
integer minor units at a fixed scale of 36 (`toMinor` → `parseUnits`), and `parseUnits` throws
`RangeError` rather than rounding when the input carries more fractional digits than the scale.
Fiat is produced by a `precision: 40` decimal clone, and `valueOne` divides for USD→EUR, whose
result is non-terminating — so a value with a one- or two-digit integer part can carry 38–39
fractional digits. If such a value reaches `toMinor`, the `RangeError` is not a `ToolError` and
surfaces as an opaque `INTERNAL` from `recon_suggest_matches` / `recon_status`.

What is confirmed: the ceiling, the throw, and that `divide` can produce more than 36 fractional
digits. What is **not** confirmed is reachability end to end — it needs a EUR-target tenant
valuing a USD-quoted snapshot, or a stored `fiat_value` above 36 dp, and no test or fixture
exercises it. Recorded with the open question named rather than asserted, because the honest
next step is a reproduction attempt, not a fix. Trigger: the first cross-currency reconciliation
against a volatile token; write the repro before changing anything. Where:
`packages/recon/src/match/score.ts` (`COMPARE_SCALE`, `toMinor`), `packages/core/src/money.ts`
(`parseUnits`), `packages/pricing/src/value.ts` (`valueOne`). *(ADR sweep, 2026-09-15)*

## Face B (reconciliation & matching)

**The subset-search heuristic's known miss-mode: the candidate pool is a top-6 SELECTION,
not "any ≤ 6 events."** An exact split whose smallest member falls outside that pool is
unreachable by the search, even though ≤ 6 events would in principle suffice — a second,
independent miss-mode from the already-documented "needs a larger combination" case. The
pool is built in three steps and the order matters: every event above `open + band` is
dropped FIRST, the survivors are sorted descending with an event-id tiebreak, and only then
are 6 taken. Why deferred: a conscious complexity cap (ADR-010), now characterization-tested
so widening the pool later is a deliberate choice, not an accidental behavior change; a
record the search misses stays `open` or, if a single event still qualifies on address,
`partial` — a visible, honest failure mode, not silent incorrectness. Trigger: real invoice
data shows the small-member-outside-top-6 case often enough to justify a larger or smarter
pool (e.g. also including the ≤ 6 smallest, or a proper bounded subset-sum). Where:
`packages/recon/src/match/engine.ts` (`MAX_SUBSET_EVENTS`, `findBestSubset`); the
authoritative description is ADR-010 d3,
mirrored in `02-mcp-contracts.md` §6.4 and `packages/recon/test/match.test.ts`. *(ADR sweep,
2026-09-15: this entry, ADR-010's 2026-08-06 amendment and §6.4 all described the pool as
"the ≤ 6 largest-valued events in the date window" — a different pool, and all three agreed
with each other, which is how it survived. With `open = 3000`, `band = 30` and a window of
`[5000, 900, 800, 700, 600, 500, 400]` the real pool is `{900…400}`, not `{5000…500}`.
Corrected in place; the miss-mode recorded here is unaffected. Originally raised by the
ADR-010 amendment on `fix/match-engine-edges`.)*

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

**Legs are never apportioned, so ADR-010 d2's batch-settlement half of the m:n model is
unreachable.** Both emit sites in the engine set `amountAppliedRaw` to the **whole** event
amount — the leg type says as much ("whole event in this slice") — so one 3,000 settlement
proposed against three 1,000 invoices produces three legs each claiming 3,000. That is
reachable, because `isCandidate` admits an out-of-band event on an expected-address or
known-counterparty hit. Confirming the first passes the per-event budget check and derives
`overpaid` from 3,000 against a 1,000 record; confirming the second raises `MATCH_CONFLICT`. So
the scenario ADR-010 names as the reason pair-level legs exist fails on the first confirm and
mislabels the record on the way. The schema is right and needs no change; what is missing is a
split of the applied amount across the legs of one event, plus the status math that follows
from it. Trigger: the first real batch settlement in an interview or a pilot — this is the
Face B feature most likely to be asked for. Where: `packages/recon/src/match/engine.ts`
(both `legs.push` sites), `packages/recon/src/match/types.ts` (`SuggestedLeg`),
`packages/mcp-tools/src/recon/decision-repo.ts` (the budget check). *(ADR sweep, 2026-09-15)*

**The full-match short-circuit is not derivable from the stored `rationale`, against ADR-010's
"explainable to an auditor".** `withinBand` is inclusive and `amountScore` scores the band edge
0, so a candidate sitting exactly on the edge with an address or history hit scores above zero,
is suggested, sets `anyFullMatch` and therefore **suppresses the subset search** — while its
rationale contains no `amount` entry at all. The split that was never proposed leaves no trace,
and nothing in the record says why. The H18 fix ("a positive confidence is a non-empty
rationale") holds; this is a different decision on the same line. Why deferred: the fix is
either recording the suppression as a rationale entry or decoupling `anyFullMatch` from
`withinBand`, and choosing between them is a scoring decision, not a bug fix. Trigger: the
first auditor question about a split that was not offered. Where:
`packages/recon/src/match/engine.ts` (`anyFullMatch`), `packages/recon/src/match/score.ts`
(`withinBand`, `amountScore`). *(ADR sweep, 2026-09-15)*

**`void` is specified as a manual record state and no shipped tool can set it.** ADR-010 d2
calls it "a manual, terminal state, never derived". It exists in the schema, in the guard that
refuses decisions on a void parent, and in two tests that set it by raw SQL — there is no
`recon_void_record` tool and no other write path. So the guard is real and unreachable through
the product. Why deferred: adding the tool is a scope decision (it is a write tool with its own
HITL question), not a defect fix. Trigger: the first user who needs to write off an invoice.
Where: `packages/db/src/schema.ts` (`external_records.status`),
`packages/mcp-tools/src/recon/decision-repo.ts` (the void guard). *(ADR sweep, 2026-09-15)*

**ADR-010 d4's HITL property has no mechanism on the in-process path, and `confirmed_by` cannot
tell the two apart.** `recon_confirm_match` is an ordinary registered write tool; the audit
column is written from a hardcoded `ACTOR = 'agent'` with no user id; and the CLI agent binds
the whole registry in-process with no approval gate and a system prompt that says nothing about
requiring confirmation. On the shipped MCP surface the guarantee is real — the tool is
annotated non-read-only and a client such as Claude Desktop or Claude Code prompts the operator
— but that is the *client's* property, not this system's, and it is absent for the CLI and the
eval harness. Two independent pieces of work: a real actor on `ToolContext` written to
`confirmed_by`, and a policy for the in-process binding (filter write tools, or require an
explicit approval callback). Nothing here moves value, so P8 is not in question. Trigger:
before any deployment where the audit trail has to answer "who confirmed this". Where:
`packages/mcp-tools/src/recon/decision-repo.ts` (`ACTOR`), `apps/cli/src/agent/core.ts`
(`toolSpecs`), `packages/mcp-tools/src/context.ts`. *(ADR sweep, 2026-09-15)*

**`tokens.peg_currency` is unconstrained, so a mis-curated token is valued at face value with
no snapshot and no warning.** The recon face-value branch fires on
`isStablecoin && pegCurrency === record.currency`. Neither `tokens.peg_currency` nor
`external_records.currency` has a CHECK constraint — the `'USD' | 'EUR'` restriction is a
comment — so a token flagged `is_stablecoin=true, peg_currency='GBP'` against a GBP record is
valued 1:1, matched and exported without ever consulting a price or emitting `PRICE_MISSING`.
The volatile path is correctly guarded; this branch runs before that guard. Why deferred: the
real fix is curation-side (a CHECK, or a verified-peg list), and the exposure requires operator
error rather than hostile input. Trigger: the first non-USD/EUR peg, or opening token curation
to users. Where: `docs/architecture/schema.sql` (`tokens.peg_currency`),
`packages/mcp-tools/src/recon/match-repo.ts` (the face-value branch). *(ADR sweep, 2026-09-15)*

**ADR-005 d1's "no materialized state to invalidate in MVP" predates Face B, which
deliberately materializes `matches.fiat_value`.** It is pinned at confirm time (face value,
P5) and read back — never re-derived from events — by `recon_status`'s open amounts, the
confirm-time over-application check and `export_journal_drafts`. That is ADR-010 d5 working as
designed, not drift. Recorded rather than reworded **deliberately**: carving Face B out of d1
would read as a licence for more materialized state, which is the thing d1 exists to resist,
and the honest statement is that one bounded exception exists and is justified elsewhere.
Trigger: a second proposal to materialize a derived figure — at which point d1 needs a real
rule ("derived figures are recomputed from events unless a pinning decision says otherwise, and
each such decision names its own ADR") rather than an exception list. Where: ADR-005 d1,
ADR-010 d5, `packages/db/src/schema.ts` (`matches.fiat_value`). *(ADR sweep, 2026-09-15)*

## Sanitization & guardrails

**`UNVERIFIED_EXCLUDED` is derived from the request flag, not from what was excluded.** Every
emit site is `if (!includeUnverified) warnings.push(…)`, and the close pack pushes it
unconditionally, so it fires on a tenant with no unverified tokens and can never signal that
something *was* hidden. As a disclosure of the default policy it is fine; as ADR-011 layer 3's
"nor silently disappear" it carries no information, because it is a constant. The fix is to
thread the excluded count out of the ledger queries and emit on `> 0` — cheap per site, and
there are five: the four analytics tools that emit the warning, plus the close pack. Trigger:
fold into any slice that touches the analytics warning path. Where:
`packages/mcp-tools/src/tools/analytics-{balances,flows,counterparties,
list-events}.ts`, `packages/mcp-tools/src/tools/close-pack-data.ts`. *(ADR sweep, 2026-09-15)*

**`analytics_stablecoin_movements` excludes unverified tokens with no warning and no opt-in.**
`computeStablecoinMovements` hard-filters `verified = true`; `analyticsStablecoinInput` has no
`include_unverified`; the handler emits no `UNVERIFIED_EXCLUDED`. An auto-discovered stablecoin
therefore disappears silently from the tool whose own description calls it the most common
accountant question — exactly the failure ADR-011 layer 3 exists to prevent. (`analytics_gas`
is native-only and correctly has neither.) The recon path filters the same way, so an
unverified-token settlement is also silently unmatchable and silently absent from
`recon_status`'s unmatched count. Trigger: same slice as the entry above; this one is the more
urgent half, since here there is no way to see the excluded rows at all. Where:
`packages/ledger/src/stablecoins.ts`, `packages/core/src/schemas.ts`
(`analyticsStablecoinInput`), `packages/mcp-tools/src/recon/{match-repo,status-repo}.ts`.
*(ADR sweep, 2026-09-15)*

**Raw `counterparty_name` leaves the repository and is sanitized late, at a different cap, with
its `heavy` flag discarded.** `journal-drafts-data.ts` selects the raw hostile import string and
hands it to the exporter, which sanitizes at the default 64 — while `recon_import_invoices`
sanitizes the same column at 128. The same name therefore renders two different truncations on
two surfaces. And `journal-drafts.ts` takes `.display` only, dropping `heavy`, so the
length-cap loss that the 2026-08-06 ADR-011 amendment was written to surface produces no
warning on the export path at all. `heavy` is consumed at exactly three call sites in the tree,
none of them an exporter. Why deferred: fixing it properly means sanitizing at the repository
edge (one cap, one place) rather than adding a fourth call site, which touches the journal data
shape. Trigger: the next slice that touches `journal-drafts-data.ts`. Where:
`packages/mcp-tools/src/tools/journal-drafts-data.ts`, `packages/exporters/src/journal-drafts.ts`,
`packages/core/src/sanitizer.ts`. *(ADR sweep, 2026-09-15)*

**`ledger_trace_tool_call` echoes the stored `tool_calls.args` jsonb verbatim.** No
sanitization, no `untrusted` key, no shape constraint. `recon_import_invoices` redacts inline
`content`, but that is a size guard, not a hostility guard — `mapping` (CSV header strings
pasted in from an attacker-supplied file) and `file_path` ride through unmodified and come back
out on replay, into LLM context, with no marker for layer 2's "data, never instructions" rule to
attach to. Why deferred: the audit tool's whole point is byte-fidelity of what was called, so
the fix is an `untrusted` wrapper plus a documented shape rather than scrubbing — a contract
change to §6 that wants its own slice. Trigger: before the hosted demo, where args come from
untrusted tenants. Where: `packages/mcp-tools/src/tools/ledger-trace-tool-call.ts`,
`docs/architecture/02-mcp-contracts.md` §6. *(ADR sweep, 2026-09-15)*

**The injection eval grades the model's answer, not whether raw reached the response — and on
the default CI path it covers one case.** The grader is `finalAnswer.includes(canary)`. Nothing
asserts the canary is absent from the tool RESULTS, which is what layer 1 is. The case cannot
presently detect a layer-1 regression at all: the planted token leaves
`symbol_display`/`name_display` NULL and is `verified=false`, `name_raw` (which carries the
actual instruction) is selected by no query in the codebase, and both canaries contain `_`,
which the allowlist strips — so even a total sanitizer failure could not put the canary through
the sanitized channel. Scope compounds it: two of thirty cases declare a canary, `--smoke` runs
one of them, and `applicable.length === 0` is treated as vacuously satisfied, so a fork PR or a
keyless clone reports a green gate with the injection metric at 0/0. Why deferred: making the
grader assert over tool results is an eval-harness change (transcripts already carry the
results, so it is tractable), and choosing canaries inside the allowlist charset is a fixture
change; together they are a slice. Trigger: before relying on this gate in any external claim
— ADR-011's "verifiable from CI" is partly about it. Where:
`packages/evals/src/graders/injection.ts`, `apps/cli/src/evals/seed-case.ts`
(`plantInjectionToken`), `apps/cli/src/evals/{gate,smoke}.ts`,
`packages/evals/fixtures/evals/core-30.yaml`. *(ADR sweep, 2026-09-15)*

## Transport & auth

**`hashKey` is computed twice per authenticated request.** Pure performance nit (sha256
over a short string, twice, per request) — not a correctness issue. Trigger: revisit if
auth-path latency ever becomes a measured concern. Where: `apps/mcp-server/src/auth.ts`
(`hashKey`). *(Task 11, `fix/server-transport`)*

**`/mcp` is registered with `app.all`, so unsupported methods pay for auth before being
refused.** ADR-003 enumerated `POST/GET/DELETE` — the three the transport implements — and the
route matches PUT, PATCH, HEAD and OPTIONS too: each spends an IP rate-limit token and a live
`resolveTenantByBearer` DB round-trip before the SDK rejects it. Low impact (the request is
still refused, and the rate limiter bounds the amplification), but it is unauthenticated work
an attacker can direct. Why deferred: narrowing it means three explicit route registrations
sharing one handler config, which is a small but real refactor of the hook wiring, and the ADR
now states what is registered. Trigger: fold into any slice touching `http.ts`'s route setup.
Where: `apps/mcp-server/src/http.ts` (`app.all('/mcp', …)`), ADR-003.
*(ADR sweep, 2026-09-15)*

## Exporters

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
also unavailable through the promises API. Why deferred: the threat model is a co-resident
writer with filesystem access to the export/import root — already inside the trust boundary
those roots assume — not the model-controlled-input threat (H2) the confinement logic was
built to close.
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

**Dependency-cruiser has no `apps/* → packages/*` rule, so the edge its own header documents
is unguarded.** `.dependency-cruiser.cjs` opens by stating the layer graph
`apps/* → mcp-tools → { ledger, recon, exporters, pricing } → db → core`, and none of its ten
rules constrains what an app may import from a package: `nothing-imports-apps` and
`no-cross-app-imports` are other directions, and `not-to-unresolvable` is not a backstop
because the root workspace declares `@reconcil/ingestion` as a devDependency (see the entry
above), so an undeclared import from an app resolves by node_modules walk-up. The
`evals-layer` comment reasons explicitly that "ingestion is still barred from the read-only MCP
server runtime by `mcp-tools-layer` + `nothing-imports-apps`", which does not follow — neither
rule covers `apps/mcp-server → ingestion`. No app violates the graph today. This matters
because ADR-011's read-only claim leans on that boundary. Trigger: fold into any slice touching
`.dependency-cruiser.cjs`; the rule itself is a few lines. Where: `.dependency-cruiser.cjs`,
ADR-001. *(ADR sweep, 2026-09-15)*

**Nothing keeps `ee/` empty, and `ee/` is exempt from every gate.** Exactly one tool
configuration names it, and it is an *exclusion*: `eslint.config.mjs` ignores `ee/**`.
`pnpm-workspace.yaml` mentions it only in a comment — the `packages:` globs simply never match
`ee/`, so it is outside the workspace by omission rather than by directive. The convention
itself lives in prose — `README.md`, `CLAUDE.md`, `ee/README.md`, `docs/README.md`, ADR-001,
`docs/guide/07-contributing.md` twice, and a gitignored kanbn card — which is why it
reads as enforced. Code dropped there would be invisible to `pnpm lint` (ignored),
`pnpm typecheck` (not a project reference), `pnpm depcruise` (which cruises `apps packages`)
and `pnpm check:supply-chain` — so the directory reserved for
the paid tier is the one place where ADR-011's "guardrail claims are literally verifiable from
CI" would stop holding. Costs nothing today (the directory holds only a README), which is
exactly why it is worth fixing before it holds anything. Trigger: the first commit that puts a
file under `ee/`; better, add an emptiness assertion to CI now. Where: `pnpm-workspace.yaml`,
`eslint.config.mjs`, `package.json` (`depcruise`, `check:supply-chain`), ADR-013 d4.
*(ADR sweep, 2026-09-15)*

**The closed-tier boundary ADR-013 draws is not where the code sits.** `integration_credentials`
— QuickBooks/Xero OAuth tokens, AES-256-GCM ciphertext/nonce with a `key_version` for rotation
— lives in `packages/db`, which d2 lists as open, while d3 puts the API-push connectors in
`ee/`. Decision 4 keeps this from being a contradiction of fact (pre-gate the public repo is
the whole repo), but a later `git mv` of the connectors into `ee/` leaves their credential
table, encryption envelope and rotation column behind in the Apache-2.0 half. Probably the
right split — schema is infrastructure, the OAuth flow is the product — but it should be a
decision rather than a discovery at move time. Separately: every workspace member declares
`"license": "Apache-2.0"` (12 of 12 — 3 apps and 9 packages; the root manifest declares it
too but is not a member) and `site/` declares none, while being named in neither
d2's open list nor d3's closed one. Trigger: the gate — this is a pre-split cleanup, not a
defect. Where: `packages/db/src/schema.ts` (`integration_credentials`), `site/package.json`,
ADR-013 d1/d3. *(ADR sweep, 2026-09-15)*

## Reconciling the count

This register holds **58 entries**. The source ledger
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
  (It is back as of 2026-09-15 with five entries — see the +31 below. Worth noting rather than
  quietly reinstating: pricing looked *finished* for one release, and a sweep that asked what
  each decision derives from found the densest cluster in the repo there.)

- **+1**: one entry ADDED by the review of that same sweep — `compareTraceIds` changing the
  sentinel it derives, with no migration for already-ingested rows. Recorded rather than
  migrated because the label shapes whose ordering moved do not occur in either provider's
  output, and there was no deployment to disagree with yet. (Closed 2026-09-15 by the ADR
  sweep — see the −3 below; the migration evidence it collected survives in the entry that
  replaced it.)

- **+1**: one entry RAISED by the review of this same branch and deliberately not acted on —
  ADR-005 d2 deriving the sentinel from provider metadata while requiring it to be a function
  of the row set. It is an ADR change plus an ingestion simplification, so it gets its own
  branch rather than riding the one that surfaced it. (Acted on and closed 2026-09-15.)

- **+1**: a second entry raised by the same review and also not acted on — ADR-012 d7
  describing a confinement the implementation has outgrown. Same signal as the ADR-005 one,
  found the same way, and it goes to the same sweep. (Decided and closed 2026-09-15.)

- **−3**: three entries CLOSED and removed on 2026-09-15 by the ADR sweep (branch
  `chore/adr-audit-sweep`). Two of them were the pair this sweep was called to act on — the
  `compareTraceIds` comparator change and the ADR-005 d2 "derives from metadata" proposal;
  the proposal was implemented, so `n` is now the `(from, to, value)` rank and the label
  comparator and its property test are gone. Their residue — the sentinel having been
  re-derived twice with no migration path — is one new entry rather than nothing, since that
  part was never closed. The third is the exporters confinement *design* question, which is
  now a decision in ADR-012 d7 (accept `realpath` check-then-use, with a stop rule and a
  named trigger) instead of an open item.

- **+31**: thirty-one entries RAISED by the same sweep, tagged *(ADR sweep, 2026-09-15)*.
  The sweep asked one question of every numbered decision in ADR-001…013 — *does the
  implementation derive what the decision says it derives?* — which is how both of the
  entries above were originally found, and the answer was no far more often than expected.
  All thirteen ADRs were amended in that branch — most because the text described
  something the code neither does nor should. The thirty-one recorded here are the other
  half: cases where the ADR is right and the code is not, so the correction is a code change
  with its own branch. They cluster — five in pricing, five in sanitization, six in Face B —
  because a sweep finds a *pattern*, not a list, which is the argument for auditing a
  register rather than only appending to it.

32 − 1 + 5 + 4 + 4 + 5 + 2 − 10 + 1 − 15 + 1 + 1 + 1 − 3 + 31 = **58**, matching this
document.

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

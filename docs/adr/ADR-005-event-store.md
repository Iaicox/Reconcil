# ADR-005: Event store — append-only, composite idempotency key, gas-as-event, finality lag

**Status:** accepted · **Date:** 2026-07-14 · **Amended:** 2026-07-15 (`token_id`
added to the idempotency key — see decision 2) · 2026-07-24 (trace-level internal
transfers activated — see decision 2) · 2026-08-06 (internal transfers wired into
the worker's `native` stream; `n` re-specified from provider order to a stable
per-tx rank — see decision 2) · 2026-09-13 (the label path is taken only for
distinct trace labels in the decimal-path shape both providers send — **superseded**)
· 2026-09-15 (the trace label is no longer a rank source at all; `(from, to, value)`
is the only one — see decision 2)

## Context

P3/P4 mandate an event-sourced, idempotent ledger with reorg handling. Design questions:
the exact idempotency key across heterogeneous facts (log events, tx-level native
transfers, fees, synthetic anchors), and whether to build reorg rollback machinery.

## Decision

1. **Append-only `chain_events`**; derived figures are always computed from events
   (no materialized state to invalidate in MVP).
2. **Idempotency key `UNIQUE (chain_id, tx_hash, log_index, token_id)`** with sentinel
   `log_index` values for non-log facts: `-1` native transfer, `-2` gas fee,
   `-3` opening balance, `-(1000+n)` trace-level internal transfer *n*
   (`txlistinternal`; a tx can carry several contract-initiated native inflows, so a
   single `-1` slot cannot hold them). *n* is 0-based and is the trace's **rank inside its
   parent tx under the `(from, to, value)` tuple** — the transfer's own content, addresses
   lowercased and value compared as base units. That is the **only** rank source.

   It is deliberately **not** arrival order: the sentinel is half of the idempotency key,
   so it must be a function of the row set alone, or a re-fetch that returns the same
   traces in a different order (the overlap boundary block, or the other provider
   after a failover) would renumber them into each other's slots and `ON CONFLICT DO
   NOTHING` would silently drop a real value movement.

   *Amended 2026-09-15, superseding the 2026-09-13 amendment.* The provider's trace label
   (Etherscan `traceId`, Blockscout `index`) used to be the primary rank source, with the
   tuple as a fallback. It is now unused for ranking, because of the requirement in the
   paragraph above: **content satisfies "a function of the row set" by construction, and a
   label cannot.** If the rank comes from row content, two rows with identical content are
   interchangeable *by definition* — a re-fetch that reorders them derives the same set of
   keys, and each key carries the same derived columns whichever way round they came, so
   nothing is dropped and nothing is duplicated. (Not quite the same *(key, payload)* pairs:
   two tuple-equal rows can still differ in their untouched provider payload. That is the
   excluded property spelled out below, and it is the honest limit of this sentence.) Two
   rows carrying the same LABEL need not be interchangeable at all, which is the defect the
   2026-09-13 distinctness condition had to patch; the decimal-path shape test beside it
   confined the label path to inputs where it would agree with the tuple anyway. Three
   mechanisms across two review rounds, each narrowing further toward "use the tuple" — so
   use the tuple.

   The label path's stated benefit, preserving execution order, **reached no consumer.** No
   PRODUCTION read orders by `log_index` descending. Six order by it ascending: the five
   ledger reads (`balances.ts`, `counterparties.ts`, `flows.ts`, `gas.ts`,
   `list-events.ts`) and the close pack's transactions CSV, which is an in-memory sort rather
   than a query but renders the same inversion into an exported file. Because the
   sentinel is `-(1000+n)`, `n = 2` sorts *before* `n = 0` in every one of them: execution
   order was inverted everywhere it could be observed, exported CSV included. The remaining
   `chain_events` readers — the recon and journal paths — order by `block_time, id`; they do
   read `log_index`, but only to carry it in an event ref, never to sequence anything. The
   four descending reads are all in `processors.itest.ts`, reading sentinels back in rank
   order, which is the only place rank order is ever wanted.

   The premise was shaky too. This decision used to assert Blockscout's `index` enumerates the
   call tree per transaction, but in the smaller of the two captured fixtures carrying rows,
   five **single-trace** transactions have `index` 67, 81, 161, 98 and 17 — not a per-tx
   ordinal. No fixture in the repo exercises multi-trace ordering at all, so the claim that
   the two providers sort a tx's traces identically was never tested against either of them.

   **What this gives up**, stated rather than glossed:
   - *The tie set widens.* Arrival order remains the final tiebreak and now fires for any two
     traces in one tx agreeing on `(from, to, value)`, not only byte-identical ones. Those
     rows are interchangeable, so no value movement is dropped or duplicated and every
     derived column is identical either way.
   - *Which `raw` payload sits under which sentinel is NOT preserved* across such a tie. This
     is a **deliberately excluded property**, pinned as one by
     `packages/ingestion/test/sentinel-permutation.property.test.ts` so that a later reader
     "fixing" it recognises they would be reintroducing the label as a rank source. It is
     acceptable only because `chain_events.raw` has no reader — a fact about today's
     consumers rather than a property of the design, which is why it is written down here
     instead of assumed away.
   - *Prefix-stability is given up.* Ranking by label happened to be prefix-stable whenever a
     provider enumerated in label order, so a truncated page agreed with the whole-tx
     re-fetch. The tuple offers no such coincidence. The guarantee is unaffected — the last
     bullet under Consequences already makes "a page never stores events above its new
     cursor" the mechanism — but a redundancy behind it is gone, and it was conditional
     redundancy: it rested on provider behaviour nothing in this system verifies.
   - *Citation samples reorder.* `EVENT_REF_CAP` truncates inline event refs in query order,
     and it applies **per citation bucket** (a flows/gas/balances group spanning many
     transactions), not per transaction — so it is enough for two reordered traces to sit
     either side of a bucket's 64th ref. Cosmetic: the `totalCount` beside the refs stays
     exact and the drilldown covers the rest, so no figure moves.

   The label is **not lost.** `normalize()` stores the mapped provider row in
   `chain_events.raw` with `traceId` included, and an integration test pins that round-trip
   ("keeps the provider trace label in chain_events.raw") so a dead-code sweep cannot quietly
   remove a field that no longer has a reader in `src/`.

   **Migration.** The derived sentinel changes for any transaction carrying ≥ 2 value-moving
   internal traces; a single-trace tx is `n = 0` under any rule. Because `chain_events` is
   append-only, a changed sentinel does not collide with an already-stored row — it inserts a
   duplicate. That is safe today only because no deployment holds rows, and the change is a
   provable no-op on everything this repo has recorded: across every captured
   `txlistinternal` fixture there are 79 value-moving traces spread over 79 distinct parent
   transactions, i.e. not one multi-trace transaction. It stops being safe at the first real
   mainnet ingest, at which point re-deriving sentinels is a migration rather than a
   decision.

   One uniform key ⇒ one dedup mechanism (`ON CONFLICT DO NOTHING`) everywhere.
   `token_id` is functionally dependent on the first three columns for real logs (a log
   carries exactly one token), but load-bearing for anchored opening balances: anchoring
   writes one `opening_balance` event *per token* under a single synthetic
   `tx_hash`/`log_index` slot, and without `token_id` every token after the first would
   be silently dropped by `ON CONFLICT DO NOTHING`.
3. **Gas is an event**, synthesized per outgoing tx (`from = payer`, `amount = total fee`).
   Balance = fold over events with no special cases; gas totals get the same citation
   machinery as any flow (P2).
4. **Reorgs via finality lag, no rollback path.** Ingestion never advances past
   `head − finality_depth(chain)` (Ethereum 64, Base 600, per-chain config). Stored
   events are final by construction. A daily integrity job cross-checking computed vs
   provider balances is the intended safety net.

   *Note 2026-09-15 (ADR sweep — the decision stands, the safety net is not built).* No
   integrity job exists: `last_integrity` is read by `ledger_status` and written by nothing,
   and `WarningCode` has no member for drift. Finality-by-construction is what carries d4
   today, unaided. Tracked in `09-known-gaps.md` under the ADR-008 d1 surfacing gap.

## Alternatives considered

- **Mutable ledger rows / status flags for pending blocks** — doubles every query
  (`WHERE confirmed`), requires rollback code that will be exercised rarely and wrong
  silently. Accounting does not need sub-finality freshness.
- **Rollback-on-reorg (store to head, delete descendants of orphaned blocks)** — the
  "correct" general solution and the wrong product trade: high-risk machinery to win
  ~15 minutes of latency that no accountant asked for.
- **Gas as columns on transfer events** — breaks "balance = fold(events)", forces fee
  special-cases into every aggregation and citation path.
- **Separate tables per event kind** — kills the uniform idempotency/citation/drilldown
  machinery; a discriminator column is strictly simpler.

## Consequences

- Data lags chain head by ~13 min (Ethereum) / ~20 min (Base): acceptable and documented.
- No UPDATE/DELETE on the hot table — vacuum-friendly, backup-friendly, audit-friendly.
- Synthetic tx_hash format (`anchor:<addr>:<block>`) is non-hex by design — trivially
  distinguishable from real hashes in citations.
- Internal transfers (`txlistinternal`) carry no gas of their own (the parent tx's
  `gas_fee` already covers it), so they normalize to `native_transfer` only. Ingesting
  them closes the R3 gap where `txlist` alone omits contract-initiated native inflows, so
  the computed native balance reconciles to the recorded `eth_get_balance` (the R3
  integrity check, 04-testing.md §2).
- The worker's `native` stream fetches `txlist` **and** `txlistinternal` over the same
  window behind one checkpoint (03-ingestion.md §3). The cursor takes the **minimum** of
  the two pages' candidates so it can never pass a block whose internal transfers were
  truncated, and a block holding ≥ `PAGE_LIMIT` internal transfers fails loudly for the
  same reason a `txlist` flood does (block-granular pagination cannot split a block).
- **A page never stores events above its new cursor.** Decision 2's rank is computed over
  the traces a `normalize()` call can see, so it is a stable key only for a *whole*
  transaction: a page cut at `PAGE_LIMIT` can end mid-tx, and storing that prefix under
  ranks derived from a partial trace set would collide with the different ranks the
  overlap re-fetch derives from the full set — `ON CONFLICT DO NOTHING` dropping one real
  value movement while another re-inserts under a fresh sentinel. Withholding everything
  above the cursor removes the hazard by construction (the next window starts at
  `cursor + 1`, and the block-granular cursor can never stop inside a block, so the
  withheld rows are re-fetched *whole*), and makes "events are complete for blocks ≤
  `last_processed_block`" literally true at the write boundary.

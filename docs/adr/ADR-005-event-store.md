# ADR-005: Event store — append-only, composite idempotency key, gas-as-event, finality lag

**Status:** accepted · **Date:** 2026-07-14 · **Amended:** 2026-07-15 (`token_id`
added to the idempotency key — see decision 2)

## Context

P3/P4 mandate an event-sourced, idempotent ledger with reorg handling. Design questions:
the exact idempotency key across heterogeneous facts (log events, tx-level native
transfers, fees, synthetic anchors), and whether to build reorg rollback machinery.

## Decision

1. **Append-only `chain_events`**; derived figures are always computed from events
   (no materialized state to invalidate in MVP).
2. **Idempotency key `UNIQUE (chain_id, tx_hash, log_index, token_id)`** with sentinel
   `log_index` values for non-log facts: `-1` native transfer, `-2` gas fee,
   `-3` opening balance, `-(1000+n)` reserved for future trace-level internal transfers.
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
   events are final by construction. A daily integrity job cross-checks computed vs
   provider balances as the safety net.

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

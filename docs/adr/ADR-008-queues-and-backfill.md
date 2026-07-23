# ADR-008: Jobs — BullMQ topology; backfill = full history with anchored-window fallback

**Status:** accepted · **Date:** 2026-07-14 · **Amended:** 2026-07-23 (probe surfacing —
see Consequences)

## Context

Ingestion must run continuous live tails plus occasional heavy backfills within tight
provider budgets (R1), driven by a single worker container in compose. Backfill strategy
was an open decision: full history vs sliding window — an accounting-correctness question
in disguise: a balance is only correct if computed from the address's complete history
(or an attested baseline).

## Decision

1. **BullMQ on Redis**, queues: `tail` (high priority, one repeatable tick per chain),
   `backfill` (low priority, one page-window job per chain/address/stream), `prices`
   (daily), `token-resolve`, `integrity`, `exports`. Exponential backoff (1 min→1 h),
   8 attempts, DLQ; failures surface in `ledger_status`, never swallowed.
2. **Live beats backfill**: reserved tail concurrency so a whale backfill cannot starve
   freshness; provider token buckets + Etherscan daily-budget guard pause backfills
   first, tails last.
3. **Backfill = full history by default.** Correctness first; typical SMB wallets
   (≤ a few thousand txs) backfill in minutes within free-tier budgets.
4. **Anchored window for whales** (est. > 50k txs): fetch provider-attested balances at
   `anchor_block`, write `opening_balance` events (log_index −3), backfill from the
   anchor. The choice is explicit and human-made — `ledger_track_wallet` returns
   `suggests_anchored`, it never silently degrades coverage; all answers over anchored
   coverage carry `ANCHORED_BASELINE` (C5).
5. **Transactional checkpointing**: page insert + cursor advance in one Postgres
   transaction; crash recovery = re-run the page into the idempotency key (ADR-005).

## Alternatives considered

- **Sliding window for everyone** (e.g. 12 months) — silently wrong balances; disqualified
  for an accounting product unless anchored, and if anchored-for-all, full history for
  cheap wallets is strictly better data for the same complexity.
- **pg-boss (Postgres-only queue)** — one less container (no Redis), tempting for
  self-host; BullMQ chosen for rate-limiter/repeatable/DLQ maturity and ecosystem
  familiarity. Revisit only if Redis proves to be a self-host support burden.
- **Temporal/workflow engine** — categorical overkill for a solo MVP; the checkpoint
  state machine in Postgres already provides durable resumability.

## Consequences

- State lives in Postgres (checkpoints), coordination in Redis (queues) — Redis loss is
  recoverable by re-registering repeatables on boot.
- Whale onboarding cost is capped and predictable; the accountant consciously trades
  history depth for speed.
- The 50k threshold is a tunable guess (open question Q5).

*Amendment (2026-07-23, anchored-window slice):* the >50k probe runs **asynchronously**
as a worker job, not inline in `ledger_track_wallet`. The MCP server must not import the
provider layer (it lives in `packages/ingestion`; dependency-cruiser boundary, ADR-011),
so the write tool cannot make a synchronous provider call. `suggests_anchored` therefore
surfaces on **`ledger_status`** (the estimate is stored on the wallet's native checkpoint),
not in the write tool's response — the HITL decision point is unchanged (02-mcp-contracts
§6.2). Anchored seeding enters the `anchoring` state directly rather than via `queued`.

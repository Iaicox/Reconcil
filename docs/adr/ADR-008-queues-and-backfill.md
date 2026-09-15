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

   *Note 2026-09-15 (ADR sweep — the decision stands, the implementation does not reach it).*
   The surfacing half is not wired. `ingestion_checkpoints` has the `status='error'` state and
   a `last_error` column, `ledger_status` reads both, and **nothing writes either** — the
   checkpoint repository says so in its own comment. A failure therefore surfaces as a
   retained BullMQ job and a `logger.error` line, and a wallet whose page-1 backfill exhausted
   its 8 attempts sits at `queued` forever (the 15-second onboard re-add dedupes against the
   retained failed job) while `ledger_status` reports it as normally queued. "Never swallowed"
   is the requirement and it is not met. Tracked in `09-known-gaps.md`. The `token-resolve`,
   `integrity` and `exports` queues listed above are likewise unimplemented scope, noted in
   the worker.
2. **Live beats backfill**: separate queues and separate workers, so a whale backfill
   cannot starve freshness by occupying the tail worker.

   *Amended 2026-09-15 (ADR sweep — accuracy).* The queue-isolation half is real and is what
   the worker implements (BullMQ `priority` is never set anywhere; isolation replaces it, with
   the substitution reasoned in `apps/worker/src/queues.ts`). The second half — "provider
   token buckets + Etherscan daily-budget guard pause backfills first, tails last" — does not
   exist. There is **no rate limiter of any kind on the chain-provider path**: the transport
   is a bare `fetch` with a timeout and the ingestion seam documents itself as "deliberately
   dumb: no retries, no throttling"; only the *price* bundle is wrapped (`throttled(…, 250)`).
   Nothing at the transport distinguishes a backfill call from a tail call, so there is no
   ordering to pause in.

   The concurrencies make it worse rather than neutral: the backfill worker runs at 5 and the
   tail worker at `chains.length` (2) against a shared per-API-key budget, so under contention
   backfill takes the larger share and 429s the tail — the exact inversion this decision
   exists to prevent. Tracked in `09-known-gaps.md`.
3. **Backfill = full history by default.** Correctness first; typical SMB wallets
   (≤ a few thousand txs) backfill in minutes within free-tier budgets.
4. **Anchored window for whales** (nonce > 50k): fetch provider-attested balances at
   `anchor_block`, write `opening_balance` events (log_index −3), backfill from the
   anchor. The choice is explicit and human-made — `ledger_track_wallet` returns
   `suggests_anchored`, it never silently degrades coverage; all answers over anchored
   coverage carry `ANCHORED_BASELINE` (C5).

   *Amended 2026-09-15 (ADR sweep — accuracy).* This said "est. > 50k **txs**". The estimate
   is `eth_getTransactionCount` — the account **nonce**, which counts only transactions the
   address *sent*. It sees no inbound transfers, no `tokentx` rows and no internal transfers,
   so the wallets whose backfill actually costs the most in an accounting product — a
   payment-receiving address, an exchange deposit address — have a nonce near zero and never
   trip the suggestion. The threshold errs on the side of *coverage* (it never wrongly
   degrades a wallet), so the failure mode is cost and latency rather than wrong figures; the
   Consequences' "whale onboarding cost is capped and predictable" does not hold for the
   population it was aimed at. `estimateTxCount` is also absent from the Blockscout adapter,
   so on Base no wallet is ever flagged. A better estimator is tracked in `09-known-gaps.md`.
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

*Amendment (2026-08-06, anchor-too-recent guard — H8):* `runAnchor` resolves `anchor_from`
to a block via `getBlockByTime`, then previously clamped it to `safeHead` when the
resolved block fell inside the reorg-unsafe tip (`resolved > safeHead`). That clamp fetched
the provider-attested balance *at safeHead* but stamped the `opening_balance` event's
`block_time` at midnight-of-anchor-date — a block/time pair that no longer describes the
same instant, breaking the monotonicity `ledger/src/as-of.ts` assumes, and silently pulling
every deposit between the requested date and safeHead into the "as of anchor date" balance.
`runAnchor` now throws `AnchorTooRecentError` (`packages/ingestion/src/types.ts`) instead of
clamping — `block_number`/`block_time` on `opening_balance` rows stay mutually consistent by
construction (no clamped write is ever produced).

The rejection happens in the asynchronous `anchor` job, not synchronously in
`ledger_track_wallet` (per the amendment above, the write tool cannot make a synchronous
provider call) — so today it surfaces only as a failed BullMQ job (retry/DLQ,
`serializeError`d in the worker logs), never a clamped/mis-dated `opening_balance`.
Surfacing it to the tool/read edge rides on the pre-existing checkpoint
error-status gap (`apps/worker/src/onboard.ts`'s failure-path note) and stays deferred there.

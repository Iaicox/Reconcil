# Data Model

Full DDL: [`schema.sql`](schema.sql) (applies cleanly to `postgres:16`). This document
explains the reasoning. Related ADRs: 004 (money), 005 (event store), 006 (tenancy),
007 (pricing), 010 (matching).

## 1. Global vs tenant-owned tables

Chain data is public and identical for everyone, so it is stored once, globally.
Tenant boundary = *what you track and what you label*, not the chain data itself.

| Global (no `tenant_id`) | Tenant-owned (`tenant_id NOT NULL`) |
|---|---|
| `tokens`, `chain_events`, `price_snapshots`, `fx_rates`, `ingestion_checkpoints` | `wallets`, `clients`, `external_records`, `matches`, `tool_calls`, `integration_credentials`, `exports`, `api_keys` |
| | `entities` / `entity_addresses` (`tenant_id NULL` = built-in curated labels) |

Consequences (ADR-006):

- Two tenants tracking the same address share one ingestion run and one checkpoint —
  no duplicate provider spend, no duplicate rows.
- A tenant "sees" only events reachable through its `wallets` (repository layer joins on
  tracked addresses; every MCP tool executes inside a tenant context).
- Deleting a tenant cascades through its ownership tables; public chain data stays (it is
  public by nature — the private fact was *which* addresses the tenant tracked, and that
  is deleted). GDPR-relevant PII lives in `entities` (names) and `external_records`
  (counterparties, invoices) — both tenant-owned, both cascade-deleted.
- `clients` models an accounting firm's sub-clients (the $199 multi-client tier):
  wallets, external records, and exports can be partitioned per client inside one tenant.

## 2. Money representation (ADR-004)

**Canonical amount = base units, `NUMERIC(78,0)`.**

- On-chain amounts are `uint256` (max ≈ 1.16 × 10⁷⁷). Postgres `BIGINT` overflows at
  ~9.22 × 10¹⁸ — that is 9.3 ETH in wei; a `BIGINT` column would be a silent correctness
  bug. `NUMERIC(78,0)` holds any `uint256` exactly.
- `decimals` lives in the `tokens` registry (immutable per ERC-20 contract in practice),
  not denormalized into events.
- **Aggregate raw, scale once.** SQL sums run over `amount_raw` grouped by token; the
  result is divided by `10^decimals` exactly once, at the edge, in TypeScript, using an
  arbitrary-precision decimal library. Never scale row-by-row (rounding drift), never in SQL
  (float traps in intermediate casts).
- Fiat values (`price`, `fiat_value`, `amount` on invoices) are unconstrained `NUMERIC` in
  the display units of the named currency, full precision internally.
- **Rounding happens only at export boundaries**: half-up to 2 decimal places per journal
  line; if a journal then fails to balance by ±0.01·n, the residue goes to a dedicated
  rounding-difference line (configurable account) so every exported journal balances to
  exactly 0.00. The residue line is part of the export contract, not an error.

In code (`packages/core`):

```ts
type RawAmount = bigint & { readonly __brand: 'RawAmount' };      // base units
type DecimalString = string & { readonly __brand: 'DecimalString' }; // "1523.42", no exponent

// Boundaries: Postgres NUMERIC <-> string <-> bigint/Decimal. JSON: always strings.
// `number` is banned for monetary values: branded types + ESLint rule
// (no-restricted-syntax on arithmetic over money fields) + Zod schemas that
// reject JSON numbers for amount fields.
```

## 3. Event store: `chain_events` (ADR-005)

Append-only. Rows are never updated or deleted. Reorg safety is **by construction**:
ingestion never advances past `head − finality_depth` (see `03-ingestion.md` §4), so
everything written is final. There is no rollback path to test.

**Idempotency key**: `UNIQUE (chain_id, tx_hash, log_index, token_id)`. Re-ingestion of
any page is `INSERT … ON CONFLICT DO NOTHING` (P4). Backfill pagination deliberately
overlaps block boundaries and relies on this key to dedupe. `token_id` is redundant for
real logs (a log carries exactly one token) but load-bearing for anchored opening
balances, which write one event per token under a single synthetic
`tx_hash`/`log_index` slot (ADR-005).

**`log_index` conventions** (one uniform key for heterogeneous facts):

| `log_index` | `event_kind` | Meaning |
|---|---|---|
| ≥ 0 | `erc20_transfer` | Actual log index of the `Transfer` event |
| −1 | `native_transfer` | Top-level ETH value transfer of the tx |
| −2 | `gas_fee` | Synthesized fee event (see below) |
| −3 | `opening_balance` | Anchored-backfill baseline (synthetic `tx_hash = 'anchor:<addr>:<block>'`) |
| −(1000+n) | *(reserved)* | Future internal (trace-level) transfers, n = trace ordinal |

**Gas is an event, not a column.** For every tx where a tracked address is the sender, the
normalizer emits `gas_fee` (`from = payer`, `to = 0x0`, `amount_raw = total fee in wei`).
Payoff: the native balance is a plain fold over events —
`balance = Σ in − Σ out − Σ gas` — so every aggregate, including gas totals, is traceable
to event rows with the same citation machinery (P2). No special-cased fee arithmetic.
OP-stack chains (Base) have an L1 data-fee component not derivable from `gasPrice × gasUsed`;
the per-chain fee strategy handles it (`03-ingestion.md` §6).

**`opening_balance`** exists only for anchored-window backfills of huge wallets
(ADR-008): a synthetic event carrying the provider-attested balance at `anchor_block`.
Its citation is the provider snapshot call, not tx hashes — tools must surface the
`ANCHORED_BASELINE` warning whenever coverage includes an anchor.

**Indexes** (see inline comments in `schema.sql`):

| Index | Serves |
|---|---|
| `UNIQUE (chain_id, tx_hash, log_index, token_id)` | Idempotent ingestion; citation lookups by ref |
| `(from_addr, block_time)`, `(to_addr, block_time)` | All flow/balance queries (`WHERE addr = X AND block_time <@ period`, bitmap-OR over both) |
| `(chain_id, block_number)` | Coverage math, integrity checks at a given height |
| `(token_id)` | Stablecoin scans, spam-token audits |

Address columns store lowercase hex (CHECK-enforced), so no `lower()` wrappers or
functional indexes are needed. EIP-55 checksumming is a display concern (done at the edge).

`raw JSONB` keeps the provider payload for audit/debugging. It is server-side only:
never serialized into tool responses (P7 — it contains unsanitized strings).

## 4. Tokens

Native currencies are pseudo-token rows (`address IS NULL`, `standard = 'native'`,
one per chain) so events reference `token_id` uniformly and aggregations never
special-case ETH. `UNIQUE NULLS NOT DISTINCT (chain_id, address)` guarantees exactly one
native row per chain (PG15+ semantics).

Hostile-string split (P7, ADR-011): `symbol_raw`/`name_raw` are stored as fetched and
never leave the server; `symbol_display`/`name_display` are produced by the sanitizer at
discovery time. Tools only ever read `*_display`.

`verified` gates spam: real wallets are full of scam airdrops (fake USDT etc.). Discovery
inserts `verified = false`; a curated seed list (major stables, WETH, chain natives) ships
`verified = true`. Analytics tools exclude unverified tokens by default and say so via a
warning; the events are still in the ledger (nothing is dropped, only filtered at read
time).

`is_stablecoin + peg_currency` drive Face B tolerance math and the `peg` valuation policy
(ADR-007).

## 5. Pricing: `price_snapshots`, `fx_rates` (ADR-007)

Both are global, append-only reference data with a natural key
(`token/date/currency/source`, `date/base/quote/source`). Corrections never overwrite:
they insert a new row under `source = 'manual'`, and consumers pick by explicit source
priority. Anything that values anything (`matches`, export manifests) stores the exact
`price_snapshot_id` / `fx_rate_id` it used — re-running the report cannot silently
produce different numbers (P5).

`source = 'peg'` rows are synthesized (price ≡ 1.0 in `peg_currency`) so that even
peg-policy valuations have a citable snapshot row.

ECB publishes EUR-base rates on business days only; the documented lookup rule is
"latest `rate_date` ≤ target date", and the chosen row's actual date is visible in
citations (an auditor sees that a Saturday payment used Friday's rate).

## 6. Reconciliation: `external_records`, `matches` (ADR-010)

**Option C seam #1** lives here: `external_records.kind` is a discriminator
(`'invoice'` today; `'bill'`, `'agent_charge'` later) — the matching engine binds
*external record ↔ settlement event*, not *invoice ↔ transfer*.

`UNIQUE NULLS NOT DISTINCT (tenant_id, client_id, kind, source, external_ref)` makes CSV
re-import idempotent *per client* (records partition per client, ADR-006): the same file
can be dropped twice — existing refs are skipped and reported — while two clients of one
firm may legitimately use the same invoice number. `NULLS NOT DISTINCT` keeps
single-company rows (`client_id IS NULL`) deduplicating as one scope.

**`matches` are pair-level legs**, m:n by construction:

- one invoice ← several transfers (partial payments): several rows share
  `external_record_id`;
- one transfer → several invoices (batch settlement): several rows share
  `chain_event_id`;
- `amount_applied_raw` says *how much of the event* this leg consumes.

Cross-row invariants are enforced in the repository layer (single writer, SERIALIZABLE
transaction for confirm/reject) and pinned by property tests, not triggers:

1. `Σ amount_applied_raw` over non-rejected legs of one event ≤ `event.amount_raw`.
2. Record status is a pure function of its confirmed legs:
   `open` (0) → `partially_matched` (< amount) → `matched` (= amount within tolerance) →
   `overpaid` (> amount). `void` is manual and terminal.

Valuation of each leg is pinned (`price_snapshot_id`, `fx_rate_id`) at suggestion time and
recomputed-and-repinned at confirmation time if stale — the confirmed numbers are the
ones exported.

`rationale JSONB` records which deterministic rules fired (amount-within-tolerance,
date window, expected address hit, counterparty history) with weights — the agent
*explains* suggestions by reading this; it never invents its own match logic (P1).

## 7. Interface tables

**`tool_calls`** is the citation anchor (P2): every tool response's `tool_call_id` is a row
here (ULID → time-ordered, no sequence contention), persisted *before* the response
returns, with the coverage snapshot and a digest of the canonical result. `trace_tool_call`
replays any past answer's provenance. Retention: keep forever pre-gate (volume is trivial);
revisit post-gate.

**`api_keys`**: sha256 hashes only; used by the hosted streamable-HTTP transport (ADR-012).

**`integration_credentials`**: AES-256-GCM under `MASTER_KEY` (env), per-row nonce,
`key_version` for rotation. Decrypted only in memory during an export push (post-gate;
MVP exports are files). Secrets never appear in logs — enforced by a serializer redaction
list plus a log-scrubbing test (P9).

**`exports`**: artifact registry. `manifest JSONB` is the audit trail of a generated file:
coverage refs, price/fx snapshot IDs, tool-call IDs, row counts, rounding residues. A close
pack is reproducible from its manifest.

## 8. Volumes and scaling posture

Design target pre-gate: an accounting firm with ~20 clients × ~10 wallets × ~5k events
≈ 1M `chain_events` rows — trivial for Postgres with the indexes above. A single whale
wallet (100k+ txs) is the stress case and is handled by anchored backfill (ADR-008), not
by schema complexity. Deliberately absent until post-gate: partitioning, BRIN indexes,
materialized views (aggregations are computed per query; the event store is the only
source of truth), read replicas, RLS (repository-layer scoping first — ADR-006).

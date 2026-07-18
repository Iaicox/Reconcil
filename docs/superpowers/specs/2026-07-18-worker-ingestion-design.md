# Worker Ingestion Slice — BullMQ host, checkpoint SM, idempotent writes — Design

**Date:** 2026-07-18 · **Status:** approved (brainstorm session)
**Related:** ADR-002 (Drizzle), ADR-004 (money), ADR-005 (event store), ADR-008 (queues &
backfill), ADR-009 (provider abstraction), `docs/architecture/03-ingestion.md`,
`docs/architecture/04-testing.md` §3, and the prior slice
`docs/superpowers/specs/2026-07-16-provider-fixtures-ingestion-design.md` (§2, §11 defer
this work here).

## 1. Goal

Turn `apps/worker` from a heartbeat stub into a **BullMQ ingestion host** and grow
`packages/ingestion` from a pure `normalize()` into a full ingestion pipeline that drives
the checkpoint state machine and writes append-only `chain_events` **idempotently**. This
closes the weeks 1–3 DoD (00-overview §6): *"golden fixtures ingest deterministically on
both chains."*

The slice implements the five must-do carry-overs from the fixtures slice:

1. Checkpoint state machine + backfill/tail processors; ingestion never advances past
   `head − finality_depth(chain)` (ADR-005).
2. Idempotent `chain_events` writes via `UNIQUE (chain_id, tx_hash, log_index, token_id)`
   with `ON CONFLICT DO NOTHING`.
3. Receipt-derived `logIndex` for erc20 transfers — no provider returns it (spec §11);
   Base receipts come from a public JSON-RPC endpoint (indexer APIs don't serve them).
4. RPC fee path (`receipts-opstack`) + programmatic `migrate()` at worker start
   (`drizzle-orm/node-postgres/migrator`, **not** drizzle-kit).
5. A logger that never prints `err.cause` (hostile provider text lives there, ADR-011).

## 2. Scope

**In scope**

1. `packages/core`: structured logger + `serializeError()` (drops `cause` / raw strings);
   `chains.config.ts` gains `rpcUrlEnv?` (Base = `BASE_RPC_URL`).
2. `packages/db`: `runMigrations(pool)` — programmatic drizzle migrator over
   `packages/db/migrations`.
3. `packages/ingestion`:
   - `RawReceipt` extended with `from`, `to`, `logs: RawLog[]`; adapter Zod + `mapReceipt`
     parse them.
   - `providers/rpc.ts` — keyless JSON-RPC `eth_getTransactionReceipt` provider (Base).
   - `providers/provider-factory.ts` — per-chain providers from config + env, ordered
     failover (etherscan-v2 → blockscout), receipts routed to RPC on `receipts-opstack`.
   - `logindex.ts` — pure `assignErc20Metadata()` (receipt-derived `logIndex` + tx from/to).
   - `normalize()` — fills `txFrom`/`txTo`; erc20 consumes receipt-enriched rows.
   - `write/` — `token-repo`, `event-writer`, `checkpoint-repo` (transactional cursor).
   - `processors/` — `runBackfillPage`, `runTailTick` (injected deps, no Redis).
4. `apps/worker`: BullMQ host — `config.ts` (Zod env), `queues.ts` (tail high / backfill
   low, retry 8×1 min→1 h, DLQ), `main.ts` (migrate on boot → pool → redis → queues →
   workers → repeatable tail per chain → graceful shutdown).
5. `capture.ts` extension: record `eth_getTransactionReceipt` (with logs) for erc20 txs;
   `manifest.json` receipt counts.
6. Integration + property tests on testcontainers Postgres; CI `integration` job.
7. Doc reconcile: `03-ingestion.md` §1 marks `anchoring` deferred (matches the DDL CHECK).

**Out of scope** (later slices)

- Anchored-window backfill (`anchoring` state, `opening_balance` / `log_index −3`,
  `anchor:<addr>:<block>` synthetic hash, balance-at-block seeding).
- `token-resolve` queue + the display-string sanitizer (this slice writes `verified=false`
  tokens with `*_display = NULL`).
- Integrity job, prices/FX, exports queues.
- Redis token-bucket rate limiter + circuit breaker (the `FetchJson` seam wraps them later;
  BullMQ retry/backoff + ordered failover cover this slice).
- Internal (trace) transfers (`log_index −(1000+n)` stays reserved); ERC-721 (`tokennfttx`).

## 3. Architecture

```
apps/worker (BullMQ host)                 packages/ingestion (domain, no Redis)
┌──────────────────────────┐              ┌───────────────────────────────────────┐
│ main.ts                  │              │ provider-factory ── etherscan-v2       │
│  runMigrations(pool)     │              │      │              blockscout          │
│  Queue: tail (high)      │ ── deps ──▶  │      │              rpc (base receipts) │
│  Queue: backfill (low)   │              │      ▼                                  │
│  Worker: tail  ─────────────┐           │ runBackfillPage / runTailTick          │
│  Worker: backfill ────────┐ │           │   getHead → safeHead                   │
│  repeatable tail/chain   │ │ │          │   getPage → getReceipts                │
│  SIGTERM: drain & close  │ │ │          │   assignErc20Metadata (logindex.ts)    │
└──────────────────────────┘ │ │          │   normalize(ctx)                       │
                             │ │          │   tx { event-writer + checkpoint-repo } │
        BullMQ job ──────────┘ └────────▶ │        (single Postgres transaction)   │
                                          └───────────────────────────────────────┘
                                                          │
                                                   Postgres (chain_events,
                                                   ingestion_checkpoints, tokens)
```

**Key property:** all provider I/O + write logic lives in `packages/ingestion` as
injected-dependency async functions, unit/integration-testable with `FixtureTransport` +
testcontainers Postgres and **no Redis**. `apps/worker` is a thin BullMQ adapter — it owns
queues, repeatables, retry/backoff, and shutdown, nothing else (00-overview §2:
"all provider I/O, rate limiting, and retries live in the worker"; the domain logic it
drives lives in the package).

## 4. File layout

```
packages/core/src/
├── logger.ts               # structured JSON logger + serializeError (drops cause)
├── chains.config.ts        # + rpcUrlEnv?: string  (base → 'BASE_RPC_URL')
└── index.ts                # + logger, serializeError

packages/db/src/
├── migrate.ts              # runMigrations(pool): migrator over ../migrations
└── index.ts                # + runMigrations

packages/ingestion/src/
├── types.ts                # + RawLog; RawReceipt.{from,to,logs}; NormalizedEvent.{txFrom,txTo}
├── logindex.ts             # assignErc20Metadata(rows, receiptsByHash) — pure
├── normalize.ts            # txFrom/txTo; erc20 uses receipt-enriched rows
├── providers/
│   ├── etherscan-v2.ts     # receiptResult + mapReceipt gain logs/from/to
│   ├── blockscout.ts       # (reuses mapReceipt)
│   ├── rpc.ts              # NEW: JSON-RPC eth_getTransactionReceipt provider
│   └── provider-factory.ts # NEW: config+env → providers, ordered failover
├── write/
│   ├── token-repo.ts       # resolveTokenId: native + unverified erc20 upsert
│   ├── event-writer.ts     # insertEvents: ON CONFLICT DO NOTHING
│   └── checkpoint-repo.ts  # read + transactional advance
├── processors/
│   ├── backfill.ts         # runBackfillPage(deps, target)
│   └── tail.ts             # runTailTick(deps, { chainId })
└── index.ts

apps/worker/src/
├── config.ts               # Zod env: DATABASE_URL, REDIS_URL, ETHERSCAN_API_KEY?, BASE_RPC_URL?
├── queues.ts               # queue names, connection, job options
└── main.ts                 # bootstrap + graceful shutdown

packages/ingestion/scripts/capture.ts   # + record receipts-with-logs for erc20 txs
```

## 5. Interfaces

```ts
// packages/core
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
export function createLogger(opts?: { name?: string }): Logger;
// Only { name, message, kind? } — NEVER cause (hostile) or raw token strings.
export function serializeError(err: unknown): { name: string; message: string; kind?: string };

// packages/db
export function runMigrations(pool: Pool): Promise<void>;

// packages/ingestion — types.ts additions
export interface RawLog {
  logIndex: number;      // decoded from hex at the adapter boundary
  address: string;       // emitting contract (lowercase)
  topics: string[];      // topic0 = event sig; ERC-20 Transfer has exactly 3 topics
  data: string;          // 0x-hex; ERC-20 Transfer value
}
export interface RawReceipt {
  transactionHash: string;
  from: string;          // tx sender (→ chain_events.tx_from)
  to: string | null;     // tx target (→ chain_events.tx_to; null on contract creation)
  gasUsed: string;
  effectiveGasPrice: string;
  l1Fee: string | null;
  status: '0' | '1';
  logs: RawLog[];
}
export interface NormalizedEvent {
  /* …existing… */
  txFrom: string;        // tx-level sender (lowercase)
  txTo: string | null;   // tx-level target (lowercase; null on contract creation)
  raw: unknown;          // source provider row → chain_events.raw (server-side only, NOT NULL)
}

// logindex.ts — pure
export interface Erc20WithMeta extends RawErc20Transfer {
  logIndex: string;      // now non-null (from receipt)
  txFrom: string;
  txTo: string | null;
}
export function assignErc20Metadata(
  rows: RawErc20Transfer[],
  receiptsByHash: ReadonlyMap<string, RawReceipt>,
): Erc20WithMeta[];      // throws on missing receipt / unmatched transfer

// processors — injected deps, no Redis
export interface ProcessorDeps {
  db: Db;
  providerFor(chainId: number): ChainDataProvider;   // with receipts routed per chain
  logger: Logger;
}
export interface BackfillTarget { chainId: number; address: string; stream: 'native' | 'erc20'; }
export interface BackfillResult { status: 'backfilling' | 'live'; lastProcessedBlock: number;
                                  inserted: number; unseenContracts: string[]; }
export function runBackfillPage(deps: ProcessorDeps, t: BackfillTarget): Promise<BackfillResult>;
export function runTailTick(deps: ProcessorDeps, t: { chainId: number }): Promise<void>;
```

## 6. Receipt → logIndex + tx-level fields (D1/D2)

One `eth_getTransactionReceipt` per tx feeds three needs at once, so the worker fetches
receipts for **`{ every tx bearing an erc20 transfer } ∪ { outgoing txs on receipts-opstack
chains }`**:

- **gas** (`receipts-opstack`): `gasUsed × effectiveGasPrice + l1Fee` (already in
  `normalize()`, now sourced through the factory's receipt route).
- **erc20 `logIndex`**: `assignErc20Metadata` matches each `tokentx` row to its Transfer log
  by `(address==contract, topics[1]==from, topics[2]==to, data==value)`, consuming logs in
  ascending `logIndex` so duplicate identical transfers get distinct indexes. Filter to logs
  with **exactly 3 topics** and `topics[0] == keccak("Transfer(address,address,uint256)")`
  (ERC-721 has 4 topics → excluded). Missing receipt or unmatched row → **throw** (contract,
  not fallback — mirrors the existing `receipts-opstack` gas guard; keeps synthetic ordinals,
  spec §11 option 4, rejected).
- **tx-level from/to**: `receipt.from` / `receipt.to` → `chain_events.tx_from` / `tx_to`
  (both required; `tx_to` NULL only on contract creation).

Receipt source per chain: Ethereum via the indexer adapter's `getReceipts`
(`module=proxy&action=eth_getTransactionReceipt`, returns full receipt incl. logs); Base via
`providers/rpc.ts` over `BASE_RPC_URL` (indexer APIs don't serve receipts on Base — spec §7
amendment). The RPC provider is raw JSON-RPC over `fetch` — **no signing/RPC library**
(dependency-cruiser ban, P8).

## 7. Write layer (D4/D6)

**`token-repo.resolveTokenId(tx, event)`** — `chain_events.token_id` is a `NOT NULL` FK, and
`token-resolve` is deferred, so the writer inline-upserts a minimal token row and returns its
id (`INSERT … ON CONFLICT (chain_id, address) DO NOTHING` then `SELECT`):

- native → pseudo-token (`address IS NULL`, `standard='native'`, `decimals`/`symbol_raw` from
  `chains.config`, `verified=false`).
- erc20 → `standard='erc20'`, `symbol_raw`/`name_raw` from `tokentx` (stored raw, **never
  logged**), `symbol_display`/`name_display = NULL`, `verified=false`. `decimals` coerced to
  `0` when `tokenDecimal` is outside the DDL's `0..36` CHECK (base-unit ledger stays exact;
  display is a later `token-resolve` concern).

**`event-writer.insertEvents(tx, rows)`** — bulk `INSERT INTO chain_events … ON CONFLICT
(chain_id, tx_hash, log_index, token_id) DO NOTHING`. Maps `NormalizedEvent` → row incl.
`token_id` (from token-repo), `tx_from`/`tx_to`, `provider`, and `raw` (the provider payload
for this event; server-side only).

**`checkpoint-repo`** — reads `(chain, address, stream)` state; the backfill loop advances
`last_processed_block` **in the same transaction** as the event inserts (D6): full page ⇒
`newCursor = lastItem.blockNumber − 1` (overlap re-fetch, idempotency dedupes), status stays
`backfilling`; short page ⇒ cursor = `safeHead`, status `live`. A crash mid-page re-runs the
page for free. Never query past `safeHead = head − finalityDepth(chain)`.

## 8. State machine (this slice)

```
queued → backfilling → (backfilling, cursor advances) → live → live (tail tick)
   error ← (retries exhausted) ← backfilling|live
   backfilling|live ← (backoff retry / failover) ← error
   live ↔ paused (manual)
```

`anchoring` and `queued→anchoring` are **deferred** — this slice is full-history backfill
only; the DDL CHECK already omits `anchoring`, so `03-ingestion.md` §1 is amended to mark it
deferred (no schema change). A wallet is "live" only when **all** its streams are live
(`native`, `erc20` are independent cursors).

## 9. BullMQ host (D5)

- **Queues:** `tail` (priority high, one repeatable tick per chain covering all its live
  checkpoints), `backfill` (priority low, one job per `(chain, address, stream)` page window;
  a full page re-enqueues the next window). Retry: exponential backoff **1 min → 1 h cap, 8
  attempts**, then the checkpoint goes `error` (+ `last_error`) and the job lands in the DLQ —
  surfaced later via `ledger_status`, never swallowed (ADR-008).
- **Live beats backfill:** separate queues + higher `tail` priority + reserved concurrency
  (ADR-008 §2); a whale backfill can't starve tail freshness.
- **Boot:** `runMigrations(pool)` **before** any processor runs; register repeatable tail per
  chain (Redis loss is recoverable — repeatables re-register on boot, state lives in Postgres,
  ADR-008).
- **Producers this slice:** no `ledger_track_wallet` MCP tool yet (server slice). A wallet
  enters ingestion by inserting `queued` checkpoints + enqueuing an initial backfill; the
  integration tests drive the processors directly, and a tiny dev helper seeds a wallet for
  `docker compose up` smoke runs.
- **Graceful shutdown:** SIGINT/SIGTERM → close workers (let the in-flight page finish; the
  transactional cursor makes a kill safe anyway) → close queues → end pool → quit redis.
- **Logging:** `createLogger`; on any caught error log `serializeError(err)` — `err.cause`
  (hostile) and raw token strings never reach the log.

## 10. Testing (04-testing §3)

| Test | Mechanism |
|---|---|
| logger | `serializeError` on `new Error('x', { cause: HOSTILE })` and on `ProviderError` ⇒ output excludes `cause`; raw token strings never appear |
| `runMigrations` | testcontainers PG, fresh DB ⇒ all tables present (dump matches parity ref) |
| adapters (receipt) | `FixtureTransport` + hand-written receipt fixtures with logs ⇒ `RawReceipt.{from,to,logs}` mapped, hex→decimal, ERC-721 (4-topic) excluded |
| `rpc.ts` | fixture JSON-RPC receipt bodies ⇒ same `RawReceipt` shape as the indexer path |
| `provider-factory` | primary `ProviderError` ⇒ failover to secondary; Base indexer call routes to blockscout, receipts to rpc |
| `assignErc20Metadata` | pure: single/multiple transfers per tx, duplicate identical transfers (distinct logIndex, ascending), missing receipt throws, unmatched row throws, 4-topic log ignored |
| `normalize()` | existing cases + `txFrom`/`txTo` populated; erc20 golden now closes (receipt-enriched rows) |
| write layer (integration) | testcontainers PG: token upsert (native + erc20, decimals clamp), `insertEvents` dedupes on the idempotency key, transactional cursor advance |
| processors (integration) | backfill of golden fixtures ⇒ deterministic `chain_events`; tail poll appends only new blocks; safeHead guard respected |
| **property** (inv. 5) | ingest the same fixtures twice ⇒ byte-identical table state |
| **property** (inv. 6) | write-chunk sizes {10, 100, 1000} over one normalized set ⇒ identical ledger (chunked at the writer, not HTTP — fixtures are pinned at page 1000) |

All hermetic: no network, Redis, or live provider. The erc20 end-to-end golden over *real
captured* receipts closes once `capture.ts` records receipt-with-logs fixtures (dev, network,
user-runnable: Ethereum via `ETHERSCAN_API_KEY`, Base via public `BASE_RPC_URL`).

## 11. Open questions / risks

- **Receipt-per-erc20-tx throughput.** One receipt call per erc20 tx is costly on the free
  tier (edge-spam fixture ≈ 5963 transfers). Documented gap; `eth_getLogs` over the Transfer
  topic (fewer calls, but no tx-level from/to) is the future optimization. Open, alongside the
  anchored 50k threshold (Q5).
- **Provider-value conflicts.** First write wins (`ON CONFLICT DO NOTHING`); the integrity job
  (later slice) flags balance drift — never a silent overwrite (03-ingestion §9).
- **Base receipt `l1Fee` shape** across public RPC providers — confirmed at capture; the
  adapter follows the fixture (fixtures are ground truth).

## 12. Red lines honored

- Money is `bigint`/`NUMERIC(78,0)` end to end; `amountRaw`/`amount_raw` never `number`
  (ADR-004).
- `chain_events` is append-only; the only writes are `INSERT … ON CONFLICT DO NOTHING`; no
  UPDATE/DELETE; ingestion never passes `safeHead` (ADR-005).
- Raw token strings and `err.cause` are hostile — stored in `*_raw`/`raw`, never logged,
  never in a tool response; only `serializeError`'s `{name,message,kind}` is logged (ADR-011).
- No signing/key library — Base RPC is raw JSON-RPC over `fetch`; bullmq/ioredis are clean
  (dependency-cruiser ban, P8). `packages/ingestion` still imports only `db`/`core`.
- Programmatic `migrate()` uses hand-auditable SQL migrations checked into `packages/db`
  (ADR-002); no `schema.sql`/migration change in this slice — the parity CI job stays green.

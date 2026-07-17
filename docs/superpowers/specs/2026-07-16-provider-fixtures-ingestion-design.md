# Provider Fixtures + Ingestion Adapters + Normalizer — Design

**Date:** 2026-07-16 · **Status:** approved (brainstorm session)
**Related:** ADR-004 (money), ADR-005 (event store), ADR-009 (provider abstraction),
`docs/architecture/03-ingestion.md`, `docs/architecture/04-testing.md` §2

## 1. Goal

The first slice of `packages/ingestion`: recorded golden fixtures for both providers,
the two `ChainDataProvider` adapters (Etherscan V2, Blockscout), and the pure
`normalize()` function — everything testable with **no network and no Postgres**.

## 2. Scope

**In scope**

1. `FetchJson` transport seam; adapters receive it by injection.
2. `EtherscanV2Adapter` and `BlockscoutAdapter` (etherscan-compatible endpoint),
   Zod-validated at the boundary, mapping provider JSON → shared `Raw*` shapes.
3. Pure `normalize()`: `Raw*` pages → `NormalizedEvent[]` (lowercase, `bigint`,
   kind mapping, gas synthesis incl. `receipts-opstack`).
4. `capture` script: real HTTP → frozen fixture files under
   `packages/evals/fixtures/providers/**` (scrubbed, pinned block ranges).
5. `FixtureTransport` (replay) + `RecordingTransport` (capture) — one mechanism,
   both sides of the same file format.
6. Minimal `chains.config.ts` in `packages/core` (two entries, per 03-ingestion §7).
7. Golden adapter tests, `normalize()` unit + golden tests.
8. Ride-along docs fix: `docs/README.md` ADR index line for ADR-005 still names the
   3-column idempotency key; update to `(chain, tx, log_index, token_id)`.

**Out of scope** (next specs)

- Checkpoint state machine, BullMQ queues, DB writes, transactional cursor.
- Rate limiter, circuit breaker, provider failover (the `FetchJson` seam is where
  they will wrap later, without touching adapters).
- `token-resolve` queue and the display-string sanitizer (ADR-011) — `normalize()`
  passes raw strings through untouched.
- `wallets/*.expect.json` hand-verified ledger expectations — they need the
  deterministic calc functions (come with the ledger/calc spec).
- Internal (trace-level) transfers (`txlistinternal`) — documented MVP gap
  (05-risks); reserved `log_index −(1000+n)` stays reserved.
- Price/FX ingestion.

## 3. Architecture

```
                        ┌────────────────────────────┐
    capture (one-off)   │ adapters walk the wallet   │   tests (every commit)
 realFetch ──────────▶  │ EtherscanV2Adapter         │  ◀────────── FixtureTransport
   wrapped in           │ BlockscoutAdapter          │              (url→file replay)
 RecordingTransport     │   constructor(fetchJson)   │
   (url→file record)    └────────────────────────────┘
                                     │
                              Raw* shapes (strings)
                                     │
                              normalize(ctx) — pure
                                     │
                              NormalizedEvent[] (bigint)
```

Key property: **capture reuses the adapters themselves.** The capture script drives
each adapter through a `RecordingTransport` that wraps real `fetch` and writes every
(url, response) pair to disk. Fixtures therefore cover exactly the requests the
adapters make — the two cannot drift apart.

## 4. File layout

```
packages/core/src/
└── chains.config.ts            # 2 entries: ethereum(1), base(8453) — 03-ingestion §7

packages/ingestion/
├── src/
│   ├── types.ts                # ChainDataProvider, PageQuery, Page<T>, Raw*,
│   │                           #   NormalizedEvent, FetchJson, ProviderError
│   ├── providers/
│   │   ├── etherscan-v2.ts
│   │   └── blockscout.ts
│   ├── normalize.ts
│   ├── fixture-transport.ts    # FixtureTransport + RecordingTransport + url canon
│   └── index.ts
├── scripts/
│   └── capture.ts              # tsx CLI, dev-only, not part of the build
└── package.json                # + "capture": "tsx scripts/capture.ts"

packages/evals/fixtures/providers/
├── etherscan-v2/
│   ├── 1/    *.json            # one file per HTTP request
│   └── 8453/ *.json
├── blockscout/
│   ├── 1/    *.json
│   └── 8453/ *.json
└── manifest.json               # per-wallet capture metadata (see §6)
```

## 5. Interfaces

```ts
// transport seam — deliberately dumb: no retries, no throttling (worker spec adds
// those as wrappers around FetchJson)
type FetchJson = (url: string) => Promise<{ status: number; body: unknown }>;

// per 03-ingestion §5 (unchanged)
interface ChainDataProvider {
  readonly kind: 'etherscan-v2' | 'blockscout' | string;
  getHead(chainId: number): Promise<bigint>;
  getNativeTxs(q: PageQuery): Promise<Page<RawNativeTx>>;
  getErc20Transfers(q: PageQuery): Promise<Page<RawErc20Transfer>>;
  getTokenMeta?(chainId: number, address: string): Promise<RawTokenMeta>;
  getNativeBalanceAt?(chainId: number, address: string, block: bigint): Promise<bigint>;
  getErc20BalanceAt?(chainId: number, address: string, token: string, block: bigint): Promise<bigint>;
  getReceipts?(chainId: number, txHashes: string[]): Promise<RawReceipt[]>;
}
interface PageQuery { chainId: number; address: string; fromBlock: bigint; toBlock: bigint;
                      limit: number; sort: 'asc'; }
interface Page<T> { items: T[]; /* full page ⇒ caller overlaps next window */ }

// Raw* = provider-agnostic *shapes*, values still strings (canonical semantics is
// normalize()'s job). Essential fields:
interface RawNativeTx {
  blockNumber: string; timeStamp: string; hash: string;
  from: string; to: string | null;          // null: contract creation
  value: string; gasUsed: string; gasPrice: string;
  isError: '0' | '1';
}
interface RawErc20Transfer {
  blockNumber: string; timeStamp: string; hash: string;
  logIndex: string | null;                  // see Open Question §11
  from: string; to: string; contractAddress: string; value: string;
  tokenName: string; tokenSymbol: string; tokenDecimal: string;   // hostile, pass-through
}
interface RawTokenMeta { contractAddress: string; name: string; symbol: string; decimals: string; }
interface RawReceipt   { transactionHash: string; gasUsed: string; effectiveGasPrice: string;
                         l1Fee: string | null; status: '0x0' | '0x1'; }

// normalize() output. Note: token is an address ref, NOT tokens.id — FK resolution
// is a DB-write concern (worker spec).
interface NormalizedEvent {
  chainId: number;
  txHash: string;                            // lowercase; synthetic forms come later (anchor)
  logIndex: number;                          // ≥0 log | −1 native | −2 gas (ADR-005)
  token: { kind: 'native' } | { kind: 'erc20'; contract: string };  // lowercase
  eventKind: 'erc20_transfer' | 'native_transfer' | 'gas_fee';
  fromAddr: string; toAddr: string;          // lowercase; gas_fee.to = 0x000…000
  amountRaw: bigint;                         // ADR-004: never number
  blockNumber: bigint;
  blockTime: Date;                           // UTC from provider timestamp
  provider: string;                          // adapter kind
}

class ProviderError extends Error {
  kind: 'http' | 'rate_limited' | 'malformed' | 'provider_error';
  // http: status ≥ 400 · rate_limited: etherscan "Max rate limit reached" / HTTP 429
  // malformed: Zod reject · provider_error: status:"0" envelope with a real message
}
```

## 6. Fixture format

One JSON file per HTTP request:

```json
{
  "request":  { "url": "https://api.etherscan.io/v2/api?action=txlist&address=0x…&apikey=REDACTED&chainid=1&endblock=22999999&…" },
  "response": { "status": 200, "body": { "status": "1", "message": "OK", "result": [ … ] } }
}
```

- **URL canonicalization** (shared by record and replay): query params sorted
  alphabetically; `apikey` value replaced with `REDACTED`. Key = `sha256(canonicalUrl)`
  first 8 hex chars.
- **Filename**: `<action>_<addr8>_<hash8>.json` where `addr8` = first 8 hex chars of
  the `address`/`contractaddress` param (omitted when absent, e.g. `eth_blockNumber`),
  `action` = etherscan `action` param (or last path segment). Human-greppable, hash
  guarantees uniqueness.
- **`FixtureTransport(dir)`**: canonicalize → hash → read file; missing file throws
  (test fails loudly, never silently passes). One instance per (provider, chain) dir.
- **`RecordingTransport(realFetch, dir)`**: same canonicalization, writes the file,
  passes the response through.
- **Scrubbing check**: after capture, the script greps every written file for the
  API key value and aborts if found (belt and suspenders — the key only ever appears
  in the URL, which is redacted before write).
- **`manifest.json`**: per wallet — address, role (`freelancer` | `smb-stables` |
  `edge-spam`), chains, pinned `fromBlock`/`toBlock` per chain, capture date,
  provider list. Pinned ranges make capture reproducible; fixtures are then frozen.

## 7. Adapters

Endpoints (both providers speak the etherscan-style API; base URLs from
`chains.config.ts`):

| Method | Etherscan V2 (`…/v2/api`, `chainid` param, key) | Blockscout (per-chain `…/api`, keyless) |
|---|---|---|
| `getHead` | `module=proxy&action=eth_blockNumber` (hex result) | same |
| `getNativeTxs` | `module=account&action=txlist&startblock&endblock&page=1&offset=limit&sort=asc` | same |
| `getErc20Transfers` | `module=account&action=tokentx&…` | same |
| `getNativeBalanceAt` | `module=account&action=balancehistory` **(PRO — see below)** | `module=account&action=eth_get_balance&block=` |
| `getErc20BalanceAt` | — (PRO) | `module=account&action=tokenbalance&block=` |
| `getTokenMeta` | — (`tokeninfo` is PRO; capability absent) | `module=token&action=getToken` |
| `getReceipts` | `module=proxy&action=eth_getTransactionReceipt` per hash | same |

Capability degradation is explicit per ADR-009: on the free tier the Etherscan
adapter ships **without** `getTokenMeta` / balance-at-block; Blockscout provides
them. *(Amended at capture, 2026-07-16: Blockscout's `eth_get_balance` answers in
JSON-RPC shape `{jsonrpc, id, result}`, not the account envelope — the adapter
unwraps it via the proxy path; `tokenbalance` and `getToken` use the account
envelope as documented.)* `tokentx` rows already carry `tokenName/tokenSymbol/tokenDecimal`, which is
what token discovery uses in practice. If capture shows a listed endpoint behaves
differently than documented here, the adapter follows reality and this spec gets a
one-line amendment (fixtures are the ground truth).

Quirks handled in adapters (never leak past them, per ADR-009):

- Etherscan envelope: `status: "0"` + `message: "No transactions found"` ⇒ **empty
  page, not an error**. Any other `status: "0"` ⇒ `ProviderError('provider_error')`.
- `status: "0"` + rate-limit message or HTTP 429 ⇒ `ProviderError('rate_limited')`.
- Hex vs decimal: `proxy` module returns hex strings; `account` module returns
  decimal strings. Adapters convert hex → decimal string so `Raw*` is uniform.
- Zod validation on every response body; reject ⇒ `ProviderError('malformed')`.

**Amendments from live capture (2026-07-16/17)** — fixtures are the ground truth:

- **Etherscan V2 free tier does not cover Base**: chainid=8453 answers
  `status:"0"` / "Free API access is not supported for this chain" — and it does
  so in the *account envelope shape on proxy actions*, so `unwrapProxy` detects
  the envelope-error form and routes it through the error taxonomy. On the free
  tier, Base is effectively Blockscout-only (ADR-009 amended accordingly).
- **`module=proxy` is not portable across Blockscout instances**:
  base.blockscout.com rejects it ("Unknown module", HTTP 400). `getHead` uses the
  portable `module=block&action=eth_block_number` (JSON-RPC-shaped result).
- **Full receipts are unavailable on Base from either indexer API** (Etherscan
  walled, Blockscout has no proxy module there). The `receipts-opstack` fee path
  therefore runs on public-RPC `eth_getTransactionReceipt`, exactly as
  03-ingestion §6 specifies — implemented in the worker slice. `getReceipts`
  stays on the adapters for chains/instances that serve it (works on Ethereum).

## 8. normalize()

`normalize(input: { native?: Page<RawNativeTx>; erc20?: Page<RawErc20Transfer> },
ctx: { chainId; trackedAddress; feeStrategy: 'txlist' | 'receipts-opstack';
provider: string; receipts?: Map<string, RawReceipt> }): NormalizedEvent[]`

Pure, no I/O. Rules:

1. All addresses and tx hashes lowercased. Amounts parsed with `BigInt()` — a
   non-numeric string throws (fail loud; provider data is validated upstream).
2. `RawNativeTx` with `value > 0` **and** `isError === '0'` ⇒ `native_transfer`
   (`log_index = −1`). Zero-value txs (contract calls) emit no transfer event.
3. **Failed txs (`isError === '1'`): no transfer event, but the gas fee is real** —
   rule 4 still applies.
4. For every `RawNativeTx` where `from === trackedAddress` ⇒ `gas_fee`
   (`log_index = −2`, `to = 0x0…0`, token native):
   - `txlist` strategy: `amountRaw = gasUsed × gasPrice`.
   - `receipts-opstack` strategy: `amountRaw = gasUsed × effectiveGasPrice + l1Fee`
     from `ctx.receipts`; a missing receipt for an outgoing tx throws (the worker
     must fetch receipts before normalizing — contract, not fallback).
5. `RawErc20Transfer` ⇒ `erc20_transfer`, `log_index` = provider `logIndex`
   (resolution of the missing-logIndex case: §11), token = `{ erc20, contract }`.
6. Token name/symbol strings are **not** inspected, transformed, or logged —
   hostile input passes through for the discovery path to sanitize later (ADR-011).
7. Self-transfers (`from === to`) emit one event, not two — the balance fold
   handles both legs from one row.
8. Incoming txs (tracked is `to`) emit no `gas_fee` (sender pays).
   Contract-creation txs (`to === null`): `toAddr` = zero address — the tracked
   sender's outflow (value + gas) stays correct in the balance fold, which is what
   accounting needs; attributing the created contract is out of MVP scope.
9. Output order: input order, native page before erc20 page — normalize is
   per-page; cross-page dedup is the DB idempotency key's job (ADR-005).

## 9. Capture script

`pnpm --filter @pet-crypto/ingestion capture -- --wallet 0x… --role freelancer --chains 1,8453 [--from N --to N]`

1. Reads `chains.config.ts` + `ETHERSCAN_API_KEY` from env (`.env`).
2. Resolves the pin: `--to` defaults to current `safeHead` (head − finality_depth),
   recorded into `manifest.json`.
3. Walks **both adapters** over `RecordingTransport`: head, native pages, erc20
   pages (page size 1000, ascending, until short page), balance-at-block at the pin
   (Blockscout), token meta for every distinct contract seen (Blockscout), receipts
   for outgoing Base txs (both).
4. Throttles ~250 ms between Etherscan calls (free tier 5 req/s).
5. Runs the scrub check (§6), writes/merges `manifest.json`.

Wallet selection (04-testing §2): three public third-party wallets — freelancer
(ETH+USDC, <200 txs), smb-stables (stablecoin-heavy on both chains), edge-spam
(spam airdrops). Candidates are found during implementation and **presented to the
user for confirmation before capture** (they land in a public OSS repo).

## 10. Testing (no network, per 04-testing)

| Test | Mechanism |
|---|---|
| Adapter golden | real adapter + `FixtureTransport` ⇒ assert page counts, first/last item fields, hex→decimal conversion, empty-page quirk, error mapping (hand-written error fixtures: 429, status-0, malformed) |
| `normalize()` unit | hand-built `Raw*` cases: failed tx (gas yes, transfer no), zero-value call, self-transfer, incoming (no gas), injection payload in `tokenSymbol` passes through byte-identical, `receipts-opstack` with/without `l1Fee`, missing receipt throws |
| `normalize()` golden | fixture pages ⇒ assert event counts per kind and per-token `bigint` sums (plain assertions, not snapshots — reviewable numbers) |
| Cross-provider | same wallet, same window, both providers ⇒ same normalized native+gas event set, and same raw erc20 `(txHash, contract, value, blockNumber)` tuple set (no provider logIndex exists — §11) — this is what keeps two adapters honest (ADR-009) |

## 11. Open question — resolved at capture time

**Does `tokentx` return `logIndex` on both providers?** It is part of the ADR-005
idempotency key. Blockscout's etherscan-compat API documents it; Etherscan's
`tokentx` historically did not include it. Decision procedure, in order:

1. Capture first; inspect fixtures.
2. If Etherscan includes it (V2 may) — done, `RawErc20Transfer.logIndex` is non-null.
3. If absent: fetch receipts for the affected txs at ingestion time and take the
   log index from the receipt's logs (exact, provider-independent — keeps the
   cross-provider key stable). Cost: one receipt call per ERC-20 tx on Etherscan.
4. A per-provider synthetic ordinal is **rejected** — it breaks cross-provider
   idempotency, which is the whole point of the key.

The choice is recorded in this spec (amended) before the normalizer task starts.

**RESOLVED (2026-07-17, from captured fixtures): NEITHER provider returns
`logIndex` in `tokentx`** — Etherscan V2 omits it (verified against live rows)
and Blockscout's compat rows omit it too. Binding resolution is option 3,
provider-independent log-index derivation at ingestion time, implemented in the
worker slice — either per-tx receipts (`eth_getTransactionReceipt.logs`) or
`eth_getLogs` over the Transfer topic, whichever the worker spec chooses; both
carry exact `logIndex`. Consequences for this slice:

- `RawErc20Transfer.logIndex` stays `string | null` and is null in practice;
  `normalize()` throws on null — the guard that no erc20 event reaches the DB
  without a real log index (option 4, synthetic ordinals, stays rejected).
- The golden cross-provider check compares erc20 rows as raw
  `(txHash, contract, value, blockNumber)` tuples (no logIndex available), and
  exercises `normalize()` end-to-end on native+gas events only. The erc20
  normalize golden lands with the worker slice, alongside the receipts path.

**Capture-format amendments (2026-07-17):** recorded account-module responses
have per-row `input` calldata pruned to `'<pruned>'` (no `Raw*` schema reads it;
unpruned Blockscout pages hit 90 MB on airdrop-batch txs), and token-meta /
balance-at fixtures are capped at the first 40 distinct contracts per wallet
(spam wallets hold hundreds; 2×N requests at 1 s spacing must stay bounded).

## 12. Red lines honored

- Money is `bigint`/string end to end; `number` never carries a value (ADR-004).
- Raw token strings are hostile and pass through untouched; nothing here writes
  tool responses (ADR-011).
- `packages/ingestion` stays worker-only (dependency-cruiser rule already enforces).
- No signing/key material; the only secret is `ETHERSCAN_API_KEY`, read from env by
  the dev-only capture script and scrubbed from fixtures (P9 spirit).

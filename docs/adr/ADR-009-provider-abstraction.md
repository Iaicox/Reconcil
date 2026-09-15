# ADR-009: Provider abstraction — capability interface, chains as configuration

**Status:** accepted · **Date:** 2026-07-14 · **Amended:** 2026-07-17 (free-tier
reality from fixture capture — see MVP wiring note)

## Context

P6: provider ToS and pricing are business risks; no single vendor may be load-bearing.
Option C seam #2 requires adding an EVM chain without touching code. Providers differ in
capabilities (balance-at-block, receipts, token metadata), and Base (OP-stack) needs a
different fee computation than Ethereum (ADR-005, ingestion §6).

## Decision

1. **One interface, `ChainDataProvider`**, with required paging methods
   (`getNativeTxs`, `getErc20Transfers`, `getHead`) and **optional capability methods**
   (`getNativeBalanceAt`, `getErc20BalanceAt`, `getTokenMeta`, `getReceipts`). Features
   degrade explicitly when a capability is absent (e.g. anchored backfill requires
   balance-at-block).

   *Amended 2026-09-15 (ADR sweep — accuracy).* "the tool reports which provider can serve it"
   was never built, and cannot be from where the failure happens: the capability miss throws
   inside the asynchronous `anchor` job with a generic "no provider serves X on chain N" that
   names no provider, and per ADR-008's 2026-07-23 amendment the MCP write tool does not touch
   the provider layer at all. With ADR-008 d1's `last_error` surfacing also unwired, "degrade
   explicitly" currently means a line in the worker log. Tracked in `09-known-gaps.md`.
2. **Adapters normalize shapes; one shared normalizer canonicalizes semantics**
   (lowercase, bigint, event kinds, gas synthesis). Provider quirks cannot leak past the
   adapter boundary.
3. **Chains are config entries** (`chains.config.ts`): chain id, native currency,
   finality depth, poll interval, fee strategy, ordered provider list with env-keyed
   credentials. Adding an EVM chain = one entry (+ API key). Fee strategy is part of
   chain config (`txlist` | `receipts-opstack`), because fee semantics are a chain
   property, not a provider property.

   *Amended 2026-09-15 (ADR sweep — accuracy).* "Adding an EVM chain = one entry" holds for
   **ingestion** and for nothing else. This paragraph is the authoritative list; the copies
   elsewhere point here rather than restate it. Three further sites stand between a
   configured chain and a usable one, and none of them is configuration:

   - `CHAIN_SLUG` (`packages/pricing/src/providers/types.ts`). `ChainConfig` carries no
     price-source key, so pricing keeps its own map, and a chain missing from it is skipped
     with a bare `continue`: no log, no counter, nothing in the fill result. The chain
     ingests correctly and is then **never priced**, every figure returning `PRICE_MISSING`
     with nothing saying why.
   - A curated-token seed row per chain (`db/migrations/0002_seed_curated_tokens.sql`, which
     is written per chain by construction). The runtime token writer inserts `verified: false`
     for every token, the native included (`ingestion/src/write/token-repo.ts`), and both
     `priceGaps` (`verifiedOnly` defaults true, and nothing overrides it — `FillDeps` has no
     such field) and `materializePegSnapshots` (`WHERE verified = true`) then see an empty
     token set. So a `CHAIN_SLUG` entry on its own does not price the chain either — and
     default analytics reads, where `include_unverified` is unset, show nothing.
   - **Conditionally, the worker's env record.** `apps/worker/src/providers.ts`'s
     `providerEnvFrom` hardcodes exactly `ETHERSCAN_API_KEY`, `BASE_RPC_URL` and
     `COINGECKO_API_KEY`, and `apps/worker/src/config.ts`'s schema declares the same three —
     a plain `z.object`, so anything else is stripped. `buildProviderBundle` reads
     `opts.env[chain.rpcUrlEnv]` generically and **throws** when it is missing, so a chain
     declaring any `rpcUrlEnv` or `apiKeyEnv` not in that record fails on every call. Base
     does not trip it — `BASE_RPC_URL` is one of the three — but any NEW OP-stack chain does,
     since it needs an RPC URL of its own by definition.
     Two TypeScript files, and the closed env set is deliberate: `providers.ts` says in its
     own comment that building the record from `cfg` is what "makes `loadConfig()`
     load-bearing". The hardening and the seam are the same line.

   "One entry, no code changes" is wrong three times over, and in four files: `types.ts`,
   `config.ts` and `providers.ts` are TypeScript sources and the seed is a SQL migration. And all four sites are NECESSARY without being SUFFICIENT — the seed writes no
   `coingecko_id` and `defiLlamaCoinKey` needs an address or a `coingeckoId`, so a native
   token is unpriceable with every site filled in. That is not specific to a new chain:
   **it is already true of ETH on both shipped chains**, and is recorded on its own.
   Folding the second and third sites into `chains.config.ts`, and opening the worker's env
   record — or at minimum failing loudly on each miss — is tracked in `09-known-gaps.md`.
4. **MVP wiring:** Etherscan V2 primary (single key, multichain), Blockscout secondary
   (OSS, keyless, self-host-aligned). Failover routes to the next provider on error; every
   event row records its `provider`.

   *Amended 2026-09-15 (ADR sweep — accuracy).* The failover clause said "circuit breaker
   (5 consecutive failures → open 60 s → half-open probe)". **There is no breaker.** Failover
   is a try/catch walk over the candidate list that returns on the first success, with no
   failure counter, no open/closed state and no probe; a repo-wide search finds no
   implementation. Per-provider state would not survive anyway, since the worker builds a
   fresh bundle on every `ingestOnce`.

   That is not free. On Base the Etherscan free tier errors on every call (see the 2026-07-17
   amendment below), so every `getHead`, `getNativeTxs`, `getInternalTxs` and
   `getErc20Transfers` — per page — pays one guaranteed-wasted primary call before failing
   over, against the same provider budget ADR-008 d2 is about. A breaker is the right fix and
   is tracked in `09-known-gaps.md`; what ships today is plain ordered failover.

   The `provider` stamp is also per *page*, not per row: the factory records whichever
   provider answered last, so a failover between a page's two calls labels rows the primary
   served. That has no correctness impact (the column feeds no user-facing figure) and is
   already recorded in `09-known-gaps.md`.

   *Amendment (2026-07-17, verified during fixture capture):* the Etherscan V2
   **free tier no longer covers Base** ("Free API access is not supported for this
   chain") — multichain-under-one-key requires a paid plan. On the free tier Base
   is served by Blockscout alone; the capability interface absorbs this without
   code changes (the etherscan adapter simply errors on 8453 and failover routes
   on). Also: `tokentx` carries no `logIndex` on either provider — erc20 log
   indexes come from receipts/`eth_getLogs` at ingestion time (worker), and
   Blockscout instances differ in module support (base.blockscout.com has no
   `proxy` module; head via `module=block`, OP-stack receipts via public RPC per
   03-ingestion §6).

## Alternatives considered

- **Direct RPC (eth_getLogs) as primary** — no per-address tx indexes: address-history
  queries require scanning block ranges for logs and full blocks for native transfers;
  that is an indexer project, not a feature. RPC is used only for narrow gaps (OP-stack
  receipts, token metadata fallback).
- **The Graph as primary** — no universal per-address native-transfer subgraph; would
  mean writing and hosting subgraphs per chain. Kept as a pluggable adapter, not a
  foundation.
- **Single provider, add abstraction later** — the abstraction is cheapest now (two
  providers keep the interface honest from day one); "later" is when ToS changes force it
  under pressure.

## Consequences

- Provider risk is a config change, not a rewrite; self-host users can run Blockscout-only.
- Two adapters must be maintained and fixture-tested from week 1 — accepted cost, it is
  also what keeps `normalize()` honest.
- Non-EVM chains remain out of scope by design (different event model, post-gate).

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
   balance-at-block; the tool reports which provider can serve it).
2. **Adapters normalize shapes; one shared normalizer canonicalizes semantics**
   (lowercase, bigint, event kinds, gas synthesis). Provider quirks cannot leak past the
   adapter boundary.
3. **Chains are config entries** (`chains.config.ts`): chain id, native currency,
   finality depth, poll interval, fee strategy, ordered provider list with env-keyed
   credentials. Adding an EVM chain = one entry (+ API key). Fee strategy is part of
   chain config (`txlist` | `receipts-opstack`), because fee semantics are a chain
   property, not a provider property.
4. **MVP wiring:** Etherscan V2 primary (single key, multichain), Blockscout secondary
   (OSS, keyless, self-host-aligned). Failover: circuit breaker (5 consecutive failures →
   open 60 s → half-open probe) routes to the next provider; every event row records its
   `provider`.

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

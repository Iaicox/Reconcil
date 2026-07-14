# ADR-007: Pricing — daily UTC snapshots, DefiLlama/CoinGecko + ECB, pinned by FK

**Status:** accepted · **Date:** 2026-07-14

## Context

P5: the exact price used in any computation must be stored and reusable — an auditor
re-running a report must get identical numbers. Face B needs EUR equivalents at payment
date. Stablecoins pose a policy question: book at peg (1.0) or at market (±0.3%)?

## Decision

1. **Granularity: daily UTC close.** Accounting works on dates; intraday pricing is
   trading-grade complexity with no accounting payoff. The date of an event is the UTC
   date of `block_time`.
2. **Sources:** DefiLlama primary (keyed by chain+contract address — no ID-mapping
   table needed, generous free historical depth), CoinGecko secondary (via
   `tokens.coingecko_id`), `manual` for corrections. **ECB daily reference rates** for
   EUR (rule: latest published rate ≤ target date; the used date is visible in
   citations — `FX_DATE_SHIFTED` warning).
3. **Append-only snapshots, pinned by FK.** `price_snapshots` / `fx_rates` rows are never
   updated; corrections insert under `source='manual'` with explicit priority. Everything
   that values anything (`matches`, export manifests) stores `price_snapshot_id` /
   `fx_rate_id`. Missing price ⇒ `PRICE_MISSING` warning, never interpolation (C4).
4. **Stablecoin policy is a tenant setting** (`market` | `peg_for_stables`), default:
   peg for reconciliation tolerance math, market for analytics valuation. Peg valuations
   cite a synthetic `source='peg'` snapshot row — even 1.0 has provenance. The default is
   a validation-interview question (Q1).

## Alternatives considered

- **Fetch prices at query time** — non-reproducible (source revisions, outages change
  answers), couples every tool call to third-party latency; rejected by P5 directly.
- **CoinGecko primary** — requires per-token ID curation and free-tier historical depth
  is limited; DefiLlama's contract-address keying matches our token registry natively.
- **Hardcode stables at 1.0** — simpler, and wrong in exactly the cases (depegs) where
  an accounting tool must not be wrong; policy must be explicit and citable.

## Consequences

- Reports are reproducible forever from (events + pinned snapshot rows).
- Price gaps heal asynchronously (queued fetch), and are visible until healed — honest
  over convenient.
- Post-gate extensions (hourly pricing, more sources) are new rows/sources, not schema
  changes.

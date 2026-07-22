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

## Valuation implementation (pricing slice)

- **Decimal library: decimal.js** (ADR-004), a precision-40 half-up clone; full precision
  internally, rounding only at export. `fiat = qty × price × fx`.
- **Source priority when several rows exist for a (token, date):** a `manual` correction is
  **authoritative and outranks everything** — including a target-currency automated row that
  would avoid FX (a human override is never silently discarded to save a conversion). Among
  automated sources: a target-currency snapshot beats a USD one that would need FX, then
  `defillama > coingecko`. Under `market` policy, `peg` rows are excluded; under
  `peg_for_stables`, a verified stablecoin resolves to its `peg` row (price 1.0 in the peg
  currency), FX-converted to the target if they differ.
- **FX direction:** ECB publishes EUR-based rates (`rate` = USD per 1 EUR). USD→EUR
  divides by the rate, EUR→USD multiplies. The rate row for a date is the latest with
  `rate_date ≤ date`; a shift emits `FX_DATE_SHIFTED`.
- **Peg rows are materialized**, not virtual: the fill inserts a `source='peg'`, price 1.0
  row per verified stablecoin per activity date, so even 1.0 cites a real, pinnable snapshot.
- **The fill worklist comes from `chain_events`** (only what the ledger could value): a gap
  is a verified (token, date) with no market snapshot yet; `peg` rows don't satisfy it.
- **Aggregate-flow valuation uses one representative date per row** (`analytics_flows`): a
  `day` bucket values at that day, a `month` bucket at the month's last day, and an untimed
  group at `period.to`. A period sum is valued once at that date (not per-event) — lossy but
  reproducible and fully pinned; a per-event valuation is deferred (post-gate). For a **partial
  final month** the representative date is still that month's last day, so the pinned snapshot may
  sit just past `period.to` — deterministic by design (a month's valuation date does not depend on
  where the query window happens to end), and surfaced as `PRICE_MISSING` if that snapshot is absent.

## Consequences

- Reports are reproducible forever from (events + pinned snapshot rows).
- Price gaps heal asynchronously (queued fetch), and are visible until healed — honest
  over convenient.
- Post-gate extensions (hourly pricing, more sources) are new rows/sources, not schema
  changes.

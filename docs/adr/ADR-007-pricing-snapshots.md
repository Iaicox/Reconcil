# ADR-007: Pricing — daily UTC snapshots, DefiLlama/CoinGecko + ECB, pinned by FK

**Status:** accepted · **Date:** 2026-07-14

## Context

P5: the exact price used in any computation must be stored and reusable — an auditor
re-running a report must get identical numbers. Face B needs EUR equivalents at payment
date. Stablecoins pose a policy question: book at peg (1.0) or at market (±0.3%)?

## Decision

1. **Granularity: one price per UTC date.** Accounting works on dates; intraday pricing is
   trading-grade complexity with no accounting payoff. The date of an *event* is the UTC date
   of its `block_time`.

   *Amended 2026-09-15 (ADR sweep — accuracy).* Two words here described something the
   implementation does not do.

   - It said daily UTC **close**. It is not a close. DefiLlama is asked for a literal
     **00:00 UTC** timestamp with `?searchWidth=6h` — the day's open, and that half is
     unambiguous. CoinGecko is asked for a bare `date=DD-MM-YYYY`, which requests no instant
     at all and leaves the choice to the provider.

     So the accurate statement is the weaker one: **one figure per UTC date, from a provider
     asked for the start of it or for nothing more precise than the date.** That is a
     defensible granularity for accounting and is the one in force; "close" was never it.

     Two things this repo does **not** establish, flagged as inference rather than stated as
     fact because no captured fixture or provider contract here pins either: which instant
     CoinGecko resolves a bare date to, and whether `searchWidth` searches backwards as well
     as forwards (the adapter's own prose says "the close nearest a timestamp within
     searchWidth", which reads symmetric). If it does search backwards, a tick from the
     *previous* UTC date could be persisted under the requested one, and nothing would record
     it — `DailyPrice` carries no timestamp, and there is no price analogue of
     `FX_DATE_SHIFTED`. `09-known-gaps.md` carries that with the same split: the missing
     provenance is confirmed, the neighbouring-date reachability is not, and the first step
     there is to capture a fixture rather than write a fix.
   - It said the date of an event is the UTC date of `block_time`, unqualified. That holds
     for a `day`-grouped row. For a `month` group the valuation date is the month's last day,
     and for an **ungrouped** aggregate it is `period.to` — a caller-supplied parameter
     (`repDate`, `packages/mcp-tools/src/rep-date.ts`), which `02-mcp-contracts.md` §6.1
     already documents. The consequence is worth stating plainly rather than leaving to be
     discovered: the same underlying rows queried with a different `period.to` pin a
     different `price_snapshot_id` and produce a different fiat total. Reproducibility is
     per *request*, not per row set, and a citation is what closes that gap — which is why
     the pinned id travels with the figure.
2. **Sources:** DefiLlama primary (keyed by chain+contract address — no ID-mapping
   table needed, generous free historical depth), CoinGecko secondary (via
   `tokens.coingecko_id`), `manual` for corrections. **ECB daily reference rates** for
   EUR (rule: latest published rate ≤ target date; the used date is visible in
   citations — `FX_DATE_SHIFTED` warning).

   *Note 2026-09-15 (ADR sweep — the decision stands, the implementation does not reach it
   yet).* The CoinGecko secondary **cannot currently serve anything**: `tokens.coingecko_id`
   is read by the gap query and written by no production path — not by the curated seed
   migration, not by token discovery — and the adapter returns `null` when it is absent. The
   failover is therefore one element deep in practice. The sharper consequence is for
   **native** tokens, which have no contract address: DefiLlama's adapter needs an address or
   a CoinGecko id, so seeded verified native ETH is unpriceable by both sources, every ETH
   balance and `gas_fee` figure degrades to `PRICE_MISSING`, and the gap re-queries on every
   tick forever. This decision is not being weakened — populating `coingecko_id` (and giving
   natives a price key) is the fix. Tracked in `09-known-gaps.md`.
3. **Append-only snapshots, pinned by FK.** `price_snapshots` / `fx_rates` rows are never
   updated; corrections insert under `source='manual'` with explicit priority. Everything
   valued **through the pricing read-core** (`matches`, export manifests) stores
   `price_snapshot_id` / `fx_rate_id`. Missing price ⇒ `PRICE_MISSING` warning, never
   interpolation (C4).

   *Qualified 2026-09-15 (ADR sweep).* This said "everything that values anything", which d4
   below and ADR-010 d5 contradict: a same-currency stablecoin leg is valued at face value
   without consulting the read-core and stores NULL refs. The universal was the half of the
   d3/d4 disagreement nobody had noticed — correcting d4 alone would have left it standing.

   *Note 2026-09-15 (ADR sweep — the decision stands, the implementation violates it).* WHICH
   snapshot gets pinned is not currently a function of the data. The candidate query carries
   **no `ORDER BY`**, and `pickSnapshot` reduces with a strict `<`, so any tie keeps whichever
   row Postgres happened to return first. The tie is reachable: the preference key returns the
   same value for **every** `manual` row regardless of currency, and the unique key
   `(token_id, price_date, currency, source)` lets a manual/USD and a manual/EUR row coexist
   for one (token, date). The winner decides both the cited `price_snapshot_id` and the figure
   itself, since one of them needs FX and the other does not — so two runs of the same tool
   call can disagree. (The same function's peg lookup takes the first `source='peg'` row
   without checking its currency.)

   This is the defect the 2026-08-05 amendment below fixed for FX — `isBetterSameDate` is a
   strict total order on source rank, then name, then highest id — and never applied to
   prices. The fix is that total order, applied here. Tracked in `09-known-gaps.md`.
4. **Stablecoin policy is `market` | `peg_for_stables`.** Peg valuations resolved through the
   pricing read-core cite a synthetic `source='peg'` snapshot row — even 1.0 has provenance.
   The intended default is peg for reconciliation tolerance math, market for analytics
   valuation; the default is a validation-interview question (Q1).

   *Amended 2026-09-15 (ADR sweep — accuracy).* Two claims, both overstated.

   - **It is not a tenant setting.** `tenants.settings` exists as a column and is read by
     nothing. `policy` is an optional field on the caller-supplied valuation argument,
     defaulting to `'market'`, and reconciliation passes `policy: 'market'` as a literal —
     the inverse of the stated reconciliation default. So the accounting policy is currently
     chosen per call, by the caller, which for an MCP surface means by the model. Wiring it
     to the tenant is tracked in `09-known-gaps.md`; the ADR keeps the intended default as
     the target rather than pretending it is in force.
   - **"Even 1.0 has provenance" does not hold on the reconciliation path**, and ADR-010 d5
     already says so ("a same-currency stablecoin at face value (peg, no snapshot)"). The two
     decisions contradicted each other and the code follows ADR-010: a stablecoin leg whose
     peg currency equals the record currency is excluded from `resolvePrices` and valued by a
     bare `formatUnits` of its base units, then stored with `price_snapshot_id = NULL`.
     (Numerically that is ×1, but no rate is read and none is written, so an auditor grepping
     for a 1.0 finds nothing.) **ADR-010 d5 governs the recon path**; this decision governs
     the pricing read-core, where a `peg_for_stables`
     resolution does pin a materialised `source='peg'` row. The cost of the ADR-010 rule is
     that a depeg is invisible to a confirmed leg, because the peg is assumed rather than
     read from a row — which is P5 face-value pinning working as designed, and is stated here
     so the two decisions stop disagreeing on paper.

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

  *Amendment (2026-08-05, determinism fix H4/H5):* `fx_rates`' unique key is
  `(rate_date, base, quote, source)`, so a `manual` correction and the automated `ecb`
  row can legitimately coexist for the same date — the same-date tie must be broken
  deterministically or two runs of the same tool call can pin different `fx_rate_id`s
  for the same figure (P5/C4). Preference order: `manual` beats `ecb` beats anything
  else (unknown sources tied alphabetically), then highest `id` as the final total-order
  tiebreak — a manual row exists specifically to override the automated feed, so it must
  win regardless of scan order. Separately, conversion is restricted to the single
  **supported pair, EUR↔USD** — ECB only publishes EUR-based rates, so that's the only
  pair with a rate to pin. `valueQuantities` checks the (snapshot currency, target) pair
  before attempting FX and routes anything else (e.g. a GBP-pegged stablecoin) to
  `PRICE_MISSING`, same as any other missing input — never a throw, and never the wrong
  number from applying the EUR/USD rate to an unrelated pair. `valueOne` keeps a
  defensive throw on an unsupported pair to document the invariant for other callers;
  `valueQuantities` never reaches it.
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

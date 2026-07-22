# ADR-004: Money representation — NUMERIC(78,0) base units, strings across boundaries

**Status:** accepted · **Date:** 2026-07-14

## Context

On-chain amounts are `uint256` in token base units (18 decimals for ETH, 6 for USDC…).
Postgres `BIGINT` overflows at ~9.22×10¹⁸ — 9.3 ETH in wei — so "bigint column" is a
latent correctness bug, not an option. Floats are banned by principle P1. The open
question was `NUMERIC` vs raw-bigint-plus-decimals, and the conversion rules.

## Decision

Both raw and scaled exist, each exactly once:

- **Storage (canonical): `amount_raw NUMERIC(78,0)`** — exact base units as on chain.
  `NUMERIC(78,0)` holds any uint256. Token `decimals` live in the `tokens` registry only.
- **Aggregation: in SQL over raw.** `SUM(amount_raw) GROUP BY token_id` is exact
  (Postgres NUMERIC arithmetic is arbitrary-precision).
- **Scaling: once, at the edge.** Display amount = raw ÷ 10^decimals, computed in
  TypeScript with an arbitrary-precision decimal library after aggregation — never
  row-by-row, never inside SQL expressions where implicit casts lurk.
- **Wire format: strings.** JSON (MCP payloads, fixtures) carries all monetary values as
  decimal strings; Zod schemas reject JSON numbers for money fields.
- **Code: `bigint` for raw, decimal lib for scaled/fiat**, branded types
  (`RawAmount`, `DecimalString`); ESLint forbids arithmetic on money via `number`.
- **Fiat: unconstrained NUMERIC**, full precision internally; rounding (half-up, 2dp)
  only at export boundaries, with a rounding-residue line guaranteeing balanced journals.
- **The decimal library is [decimal.js](https://mikemcl.github.io/decimal.js/)**, chosen
  with the pricing slice where division first appears (fiat = qty × price × fx). It is a
  private clone at `precision: 40, rounding: ROUND_HALF_UP` (`packages/pricing/src/decimal.ts`),
  so global config elsewhere can't perturb money math; `core/money.ts` stays lib-free
  (bigint↔string scaling is exact/terminating). Division/FX is confined to pricing (ADR-007).

## Alternatives considered

- **NUMERIC(38,18) scaled at write time** — loses the byte-exact correspondence with
  chain data (audit re-verification against providers becomes approximate), and a wrong
  `decimals` at ingest time becomes permanent data corruption instead of a re-derivable
  view.
- **TEXT for raw** — preserves exactness but kills in-database aggregation, forcing all
  sums through JS pagination.
- **BIGINT** — overflows; rejected as unsound.

## Consequences

- Audit story: any stored amount equals the provider/chain value literally.
- A mis-registered `decimals` is a display bug, not data corruption — fixed by updating
  the registry.
- Cost accepted: NUMERIC is bulkier and slower than BIGINT; irrelevant at ledger volumes
  (≤ millions of rows pre-gate).

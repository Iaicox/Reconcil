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
  TypeScript after aggregation — never row-by-row, never inside SQL expressions where
  implicit casts lurk. *(Amended 2026-09-15: this said "with an arbitrary-precision decimal
  library". It uses none — a power-of-ten scale is exact and terminating, so `formatUnits` is
  pure bigint↔string. The decimal bullet below already said so and the two contradicted each
  other; see the three classes of money division there.)*
- **Wire format: strings.** JSON (MCP payloads, fixtures) carries all monetary values as
  decimal strings; Zod schemas reject JSON numbers for money fields.
- **Code: `bigint` for raw, decimal strings for scaled, a decimal clone for fiat
  arithmetic**, branded types (`RawAmount`, `DecimalString`). *(Amended 2026-09-15: this
  said "decimal lib for scaled/fiat". Scaling needs no library — see the bullet above and
  the three classes below; the clone is for fiat, where quotients do not terminate.)*

  *Amended 2026-09-15 (ADR sweep — accuracy).* This originally ended "; ESLint forbids
  arithmetic on money via `number`". **No such lint rule exists** — `eslint.config.mjs` is
  `recommended` + `recommendedTypeChecked` plus a CJS override, with no `no-restricted-syntax`
  and nothing that mentions money. And the branded half is aspirational too: `RawAmount` is
  declared and exported (`packages/core/src/money.ts`) and applied to **zero** values
  anywhere in `src/` — `formatUnits` takes a plain `bigint`, and the column is
  `mode: 'bigint'` with no `.$type<RawAmount>()`. `DecimalString` is real and is applied.

  What actually holds the line today, and is worth naming because it is what a reviewer can
  check: `decimalString`/`nonNegativeDecimalString` in `packages/core/src/schemas.ts` reject
  JSON numbers for every money field at the wire, `mode: 'bigint'` keeps `amount_raw` out of
  float range at the DB edge, and aggregation is SQL-side so no JS number ever sees a sum.
  Those are three real barriers; neither named mechanism is one of them. Wiring the brand
  and adding the lint rule is tracked in `09-known-gaps.md`.
- **Fiat: unconstrained NUMERIC**, full precision internally; rounding (half-up, 2dp)
  only at export boundaries; every exported journal balances per currency — the close-pack
  draft via an appended rounding-residue line, the QBO/Xero drafts by construction (a
  non-zero residue fails the export).
- **The decimal library is [decimal.js](https://mikemcl.github.io/decimal.js/)**, chosen
  with the pricing slice where division first appears (fiat = qty × price × fx). It is used
  through a private clone at `precision: 40, rounding: ROUND_HALF_UP`, so global config
  elsewhere can't perturb money math; `core/money.ts` stays lib-free (bigint↔string scaling
  is exact/terminating).

  *Amended 2026-09-15 (ADR sweep — accuracy).* Two claims here were wrong. There is **not
  one clone but two** — `packages/pricing/src/decimal.ts` and
  `packages/exporters/src/decimal.ts` — configured identically today, which is exactly the
  hazard: naming a single file as *the* money-math config invites a future re-tune of one and
  a silent divergence from the other. And **division is not confined to pricing**:
  `netOfVat` in the exporters clone divides a gross amount by `(100 + rate)` for the VAT
  split. Structurally it has to be there — `.dependency-cruiser.cjs`'s
  `domain-depends-only-on-db-core` rule forbids `exporters → pricing`, so "confined to
  pricing" and the enforced boundary graph could never both be true.

  *Corrected again, same day.* The rule first written here — "every site that divides money
  configures its own decimal clone at `precision: 40, ROUND_HALF_UP`" — was stronger than the
  code and would have made a correct third site non-conformant the moment it was written.

  The rule has to be about what a division **produces**, not that one happens. Division
  producing MONEY happens in three classes, and only the third wants a clone:

  1. **Exact power-of-ten scaling** — `formatUnits`/`parseUnits` in `core/money.ts`, raw base
     units ÷ 10^decimals. Terminating by construction, so it is done in `bigint`/string with
     no library at all. That carve-out is the previous paragraph's own point.
  2. **Bounded integer arithmetic over minor units** — `computeBand`
     (`recon/src/match/score.ts`) derives a tolerance as `(openMinor × pctE4) / 1_000_000n`
     in `bigint`, truncating. It divides money and has no clone, deliberately: the operands
     are already integers at a fixed scale, truncation narrows the band rather than widening
     it, and the e4 precision contract is ADR-010's (amendment A6), not this decision's.
  3. **Non-terminating decimal division** — FX conversion (`pricing/src/decimal.ts`) and the
     VAT split (`exporters/src/decimal.ts`). Only here is a quotient unrepresentable and a
     rounding mode therefore load-bearing. **These, and only these, configure a private clone
     at `precision: 40, ROUND_HALF_UP`, and round only at an export boundary.** A further such
     site configures its own clone rather than importing someone else's.

  A fourth site divides money and produces something that is **not** money, and it is the one
  place a monetary value legitimately becomes a `number`: `amountScore`
  (`recon/src/match/score.ts`) returns `1 - Number(diff) / Number(band.bandMinor)`, a
  dimensionless score in [0,1] used only to rank candidates. It does not violate "money is
  never `number`" — nothing monetary comes back out, and the engine's own header says so — but
  it is worth naming rather than leaving as an apparent exception. Note the cost: at
  `COMPARE_SCALE = 36` both operands can exceed `2^53`, so each loses precision. The ratio
  survives because they lose it proportionally, and a score only has to order candidates; a
  future use of that quotient for anything but ranking would need a different construction.

  Stated this way because the failure this ADR sweep exists to catch is a decision whose rule
  does not match what the code derives. Writing one that condemns correct code is the same
  defect pointing the other way — and the first two attempts at this paragraph did exactly
  that, first by demanding a clone everywhere, then by a taxonomy that had no room for a
  division whose result is not money.

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

# ADR-010: Matching — source-agnostic records, pair-level m:n legs, deterministic scoring

**Status:** accepted · **Date:** 2026-07-14

## Context

Face B reconciles stablecoin settlements against invoices: partial payments, overpayments,
batch settlements, fee shortfalls. Option C (agentic-payment reconciliation) must remain
possible without a redesign — but must not be built. P1 forbids LLM judgment inside
matching; P8 requires human confirmation.

## Decision

1. **Source-agnostic pairing** (Option C seam #1): `external_records.kind` is a
   discriminator (`'invoice'` now; `'bill'`, `'agent_charge'` later). The engine pairs
   *external record ↔ settlement event* — nothing invoice-specific in the join model.
2. **Pair-level legs in `matches`**: each row applies `amount_applied_raw` of one event to
   one record ⇒ m:n falls out naturally (several legs per record = partials; several legs
   per event = batch settlement). Invariants: Σ legs per event ≤ event amount; record
   status (`open→partially_matched→matched→overpaid`) is a pure function of confirmed
   legs — enforced in the repository under SERIALIZABLE transactions, pinned by property
   tests. Triggers rejected: they split business logic across two runtimes and make the
   invariant untestable as a unit. Record-status derivation uses the **canonical default
   tolerance band**, independent of the suggest-time `tolerances` param (which only widens
   candidate *discovery*); status is thus reproducible from the confirmed legs plus this
   fixed policy, never from a transient per-call query param (P1/P2). `void` is a manual,
   terminal state, never derived — a leg whose record is `void` is not actionable.
3. **Deterministic scoring** with recorded `rationale` (rule hits + weights: amount within
   tolerance, date window, expected address, counterparty history). Split/partial
   candidates via bounded subset search (≤ 6 events per record). Confidence is a
   deterministic score, reproducible from rationale.
4. **HITL lifecycle**: engine writes `suggested`; only humans (via `recon_confirm_match` /
   `recon_reject_match`) transition it; only `confirmed` legs feed exports. The agent
   presents rationale and collects decisions — it never matches (P1) and never confirms
   on its own.
5. **Valuation pinned per leg** (`price_snapshot_id`, `fx_rate_id`, ADR-007). A candidate is
   valued into the record currency at **suggest** time — a same-currency stablecoin at face
   value (peg, no snapshot), any other token (volatile or cross-peg) via the pricing read-core
   at the settlement's block-time date, pinning the winning snapshot/FX on the leg; an
   unpriceable settlement can't match and stays open (never interpolated). Confirmation carries
   that pin through unchanged (the block-time snapshot is immutable), so the exported EUR/USD
   equivalent is exactly the confirmed one.

## Alternatives considered

- **Direct `invoice_id` FK on transfers** — the hard-coded 1:1 the brief explicitly
  forbids; dies on the first partial payment.
- **LLM-assisted fuzzy matching** — non-reproducible, non-citable, unauditable;
  violates P1. The LLM's role is conversation, not judgment.
- **Unbounded subset-sum matching** — NP-flavored rabbit hole; the bounded search covers
  real-world cases (few concurrent partials) and its limits are documented, not hidden.

## Consequences

- Enabling Option C later = new `kind` + possibly new scoring rules; zero schema change.
- Every match decision is explainable to an auditor from `rationale` + citations.
- Bounded search can miss exotic splits; such records simply stay `open`/partial for
  manual matching — a visible, honest failure mode.

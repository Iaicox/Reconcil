# ADR-010: Matching — source-agnostic records, pair-level m:n legs, deterministic scoring

**Status:** accepted · **Date:** 2026-07-14 · **Amended:** 2026-08-06 (edge-case
remediation — see Consequences)

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

*Amendment (2026-08-06, edge-case remediation — audit findings H18, A3–A6):*

- **No zero-confidence legs (H18).** The engine previously treated the tolerance-band
  edge as a full match (`withinBand` is inclusive, `<=`) while `amountScore` scores that
  same edge 0 — a candidate landing exactly there, with no address/history/date signal,
  was suggested at `confidence: 0` with an empty `rationale`, violating C1 ("no number
  without provenance"). `suggestForRecord` now pushes a leg — and counts it toward the
  full-match short-circuit — only when the scored confidence is `> 0`; since
  `scoreCandidate` only records a rule when it actually contributed, a positive
  confidence is a non-empty rationale by construction. The band-edge case with no other
  signal now correctly produces no suggestion, not a provenance-free one.
- **Exact `Σ weights === confidence` under the clamp (A3).** `Math.min(1, Σ)` broke the
  invariant exactly when it fired (float summation landing a hair above 1, near-
  unreachable given weights sum to 1.0 and scores ≤ 1, but not impossible). `scoreCandidate`
  now rescales every shipped weight by `1 / rawSum` when `rawSum > 1` and recomputes
  confidence **from** the rescaled rationale (not derived independently), so the two stay
  reproducible from each other by construction, not merely approximately equal.
- **Zero-amount records (A4/A5).** `deriveRecordStatus` special-cased `applied === 0n` to
  `'open'` before ever consulting the band, so a genuinely zero-amount record
  (`amount="0"`, nothing applied) could never reach `'matched'` — the band `{0,0}`
  trivially contains 0, but the short-circuit fired first. Status is now derived via the
  band FIRST; `'open'` is reserved for the true zero-progress case (`applied=0` on a
  record whose band does *not* already contain 0). Independently, `suggestForRecord` now
  returns no legs for any record with `openAmount <= 0` before scoring anything, and
  `recon_suggest_matches`'s record query filters the same condition at the SQL level —
  a freshly imported zero-amount invoice sits at `status='open'` from the DB default
  regardless of the status-derivation fix (import never calls `deriveRecordStatus`), so
  without this guard every payment from its expected sender would still be suggested as
  a settlement for an invoice with nothing outstanding.
- **Tolerance `amount_pct` precision (A6).** `computeBand` resolved percent tolerances to
  basis points (`Math.round(pct * 100)`, 2 decimal places) — `amount_pct: 0.004` rounded
  to 0 and silently collapsed the band to the absolute tolerance alone. It now resolves to
  4 decimal places (`Math.round(pct * 10_000)` over a `1_000_000n` divisor); precision
  finer than that still rounds — a documented contract, not an error.
- **Honest subset-search wording.** The engine's docstring and this contract's §6.4 text
  previously implied the only miss-mode was "a record only a larger combination would
  settle." The pool is actually the ≤ 6 LARGEST-valued candidates in the date window, so
  an exact split whose small member falls outside that top-6-by-size pool is *also*
  unreachable, independent of whether ≤ 6 events would have sufficed. Both failure modes
  are now named explicitly; no behavior changed for this point — a characterization test
  pins the small-member case as documented behavior, so widening the pool selection later
  is a conscious choice, not an accidental fix.

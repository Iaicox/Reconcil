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
   per event = batch settlement). Invariants: Σ **confirmed** legs per event, **per tenant**,
   ≤ event amount; record
   status (`open→partially_matched→matched→overpaid`) is a pure function of confirmed
   legs — enforced in the repository under SERIALIZABLE transactions, pinned by property
   tests. Triggers rejected: they split business logic across two runtimes and make the
   invariant untestable as a unit. Record-status derivation uses the **canonical default
   tolerance band**, independent of the suggest-time `tolerances` param (which only widens
   candidate *discovery*); status is thus reproducible from the confirmed legs plus this
   fixed policy, never from a transient per-call query param (P1/P2). `void` is a manual,
   terminal state, never derived — a leg whose record is `void` is not actionable.

   *Amended 2026-09-15 (ADR sweep — accuracy).* Three qualifications this decision needed.

   - **The per-event invariant is over CONFIRMED legs, per tenant.** Suggested legs are
     deliberately unconstrained — they are competing proposals, and the engine's job is to
     propose — so the check runs at confirm time only. It is also tenant-scoped, and must be:
     `chain_events` is global by design (ADR-006 d1), so two tenants tracking one wallet each
     keep their own books against the same event. Stated globally and unqualified, this
     invariant read as something neither true nor desirable.
   - **"A pure function of confirmed legs" holds on the decide path, not on import.**
     `deriveRecordStatus` has exactly one production caller, in the decision repository;
     import writes the schema default `open` and never derives. For an ordinary record the
     first confirm reconciles the two. For a zero-amount record it never does: the derivation
     would say `matched` (the band `{0,0}` contains 0) while the row stays `open` forever,
     because the suggest-time SQL filter `amount > Σ confirmed` guarantees no leg can ever
     exist to trigger a re-derivation. Harmless — a zero-amount invoice needs no settlement —
     but it is a fixed point the unqualified wording denies.
   - **The status sum carries an undeclared currency predicate.** Every applied-fiat sum adds
     `matches.fiat_currency = external_records.currency`, so a confirmed leg in another
     currency is excluded from the record's status math while still counting against that
     event's applied-raw budget, which has no currency predicate. That asymmetry is correct
     (a record is settled in its own currency; an event is spent once whatever it is valued
     in) and was simply unstated.

   The **canonical-band** half of this decision was checked against the code and holds
   exactly as written: no caller anywhere threads a suggest-time tolerance into
   `deriveRecordStatus`; the parameter exists for the hermetic band tests alone.

   One gap rather than a qualification: `void` is specified as a manual state, and **no
   shipped tool can set it**. It exists in the schema, in the guard that refuses decisions on
   a void parent, and in tests that set it by raw SQL. Tracked in `09-known-gaps.md`.

   *Note 2026-09-15 (the model stands, the engine does not use half of it).* "Several legs per
   event = batch settlement" is not reachable today. The engine never apportions: both emit
   sites set `amountAppliedRaw` to the **whole** event amount, and the leg type says so
   ("whole event in this slice"). So one 3,000 settlement proposed against three 1,000
   invoices produces three legs each claiming 3,000 — reachable, because the candidate gate
   admits an out-of-band event on an expected-address or known-counterparty hit. Confirming
   the first passes the budget check and derives `overpaid` from 3,000 against a 1,000
   record; confirming the second raises `MATCH_CONFLICT`. The m:n *schema* is right and needs
   no change — what is missing is a split of the applied amount across the legs of one event.
   Tracked in `09-known-gaps.md`; the partials direction (several legs per record) works.
3. **Deterministic scoring** with recorded `rationale` (rule hits + weights: amount within
   tolerance, date window, expected address, counterparty history). Split/partial
   candidates via bounded subset search. Confidence is a deterministic score, reproducible
   from rationale.

   *Amended 2026-09-15 (ADR sweep — accuracy).* Two descriptions here do not match the
   engine, and one amendment below describes a mechanism that never runs.

   - **The subset pool is a selection, and neither this decision nor the 2026-08-06
     "honest subset-search wording" amendment describes the one that ships.** `findBestSubset`
     first drops every event larger than `open + band` (it could only overshoot), *then* sorts
     what remains descending by value with an `eventId` tiebreak, *then* takes the top 6. The
     ceiling filter runs BEFORE the cut, so with `open = 3000`, `band = 30` and a window of
     `[5000, 900, 800, 700, 600, 500, 400]` the pool is `{900, 800, 700, 600, 500, 400}` — not
     `{5000, …}` as "the ≤ 6 largest-valued candidates in the date window" would give, and not
     "any ≤ 6 events" as this decision's bare cardinality bound reads. Also unstated anywhere:
     subsets are ranked by **fewest events first**, with confidence only as a tiebreak, so the
     proposed split is the smallest one that fits rather than the highest-confidence one.
   - **The `1/rawSum` rescale branch never executes.** Each contribution is
     `WEIGHTS[rule] * score` with `score ≤ 1`, so each term is at most its own weight; the
     weights sum to exactly 1.0 and the float accumulation in fire order lands on exactly `1`,
     never above. `rawSum > 1` is therefore unreachable with the current `WEIGHTS`, and what
     actually delivers `Σ rationale.weight === confidence` is the identity return beside it —
     `confidence` *is* the sum. The rescale is dead code kept as a guard for a future retune;
     the 2026-08-06 amendment (A3) claims it as the mechanism, which it is not. Already
     recorded in `09-known-gaps.md`, now stated where the claim lives.

   *Note (same sweep) — one decision is not derivable from the rationale.* Consequences below
   promise "every match decision is explainable to an auditor from `rationale` + citations".
   The full-match short-circuit is not: `withinBand` is inclusive, `amountScore` scores the
   band edge 0, so a candidate sitting exactly on the edge with an address or history hit
   scores above zero, is suggested, sets `anyFullMatch` and **suppresses the subset search** —
   while its rationale contains no `amount` entry at all. The split that was not proposed
   leaves no trace. Tracked in `09-known-gaps.md`.
4. **HITL lifecycle**: engine writes `suggested`; a leg is transitioned only through
   `recon_confirm_match` / `recon_reject_match`; only `confirmed` legs feed exports. The
   agent presents rationale and collects decisions — it never matches (P1).

   *Amended 2026-09-15 (ADR sweep — accuracy).* This said "only **humans** … transition it"
   and "never confirms on its own", and **nothing in the system derives either.**
   `recon_confirm_match` is an ordinary registered write tool; the audit column is written
   from a hardcoded `ACTOR = 'agent'` with no user id, so it cannot distinguish a human
   decision from a model one; and the CLI agent binds the whole tool registry in-process with
   no approval gate and a system prompt that says nothing about requiring confirmation. On
   that path the model can confirm a leg on its own turn.

   What the property actually rests on, stated honestly: **the transport client's approval
   UX.** The tool carries a non-read-only annotation, and an MCP client such as Claude
   Desktop or Claude Code prompts the operator before invoking one — that is the human. The
   guarantee is therefore real for the shipped MCP surface and absent for the in-process
   binding used by the CLI and the eval harness, and the `confirmed_by` column records
   `'agent'` either way, so the audit trail cannot tell them apart. Both halves — a real
   actor on the context, and a policy for the in-process path — are tracked in
   `09-known-gaps.md`. P8 is not in question: nothing here moves value.
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

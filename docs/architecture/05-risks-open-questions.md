# Top Risks & Open Questions

## Top-5 risks

### R1 — Provider limits and ToS (likelihood: high, impact: high)

Etherscan free tier (≈5 req/s, 100k/day) is enough for demos but a single whale backfill
can eat the daily budget; commercial-use terms of free tiers are mutable.
**Mitigations (built into the architecture):** multi-provider abstraction with failover
(ADR-009); daily budget guard that pauses backfills but keeps live tails; anchored
backfill caps whale cost (ADR-008); development runs on recorded fixtures, not live APIs;
self-host users bring their own keys (cost and ToS exposure shifts to them).
**Residual:** verify Etherscan V2 & CoinGecko/DefiLlama commercial terms before the
hosted demo goes public (open question Q4).

### R2 — Solo timeline: weeks 1–3 core is the crunch (high, high)

Two chains, finality-safe ingestion, prices, and deterministic calc in ~60–75 hours of
work is tight; slipping the core compresses the MCP/eval weeks that produce the
portfolio artifact.
**Mitigations:** fixtures-first development (no waiting on providers); Base costs ~0 extra
by design (config entry — proving the seam is the week-3 exit test); internal txs and
Safe wallets explicitly out (R3); the kill list is an ADR, not a vibe; weekly
demoable checkpoint discipline.
**Contingency:** if week 3 slips >4 days, cut `analytics_counterparties` from the week-4
tool set (restore in week 6) rather than compressing evals.

### R3 — Ledger completeness vs. reality (medium, critical for trust)

Known MVP gaps: internal (trace-level) ETH transfers (e.g., withdrawals from contracts,
DEX refunds) are invisible; Safe/multisig wallets and contract accounts are out; OP-stack
L1 fees need the receipts strategy. An accountant who catches one wrong balance never
returns.
**Mitigations:** the integrity job diff-checks computed balances against provider
balances and *tells the user* when they drift (`ledger_status`, warnings); coverage
warnings are contractual (C5); a "supported wallet types" doc states EOA-only MVP;
the `log_index` sentinel space already reserves room for internal transfers, and
Etherscan's `txlistinternal` makes them a post-gate stream, not a redesign.
**Positioning:** honesty-as-feature — the tool says when it cannot be trusted, unlike a
spreadsheet.

### R4 — MCP ecosystem churn (medium, medium)

Spec and client behavior are moving (transport, auth, tool-result shapes); claude.ai
remote connectors require OAuth that the MVP deliberately defers.
**Mitigations:** pinned SDK version with a scheduled upgrade window (one per phase);
demos run on the stable paths (stdio + Claude Code/Desktop, in-process CLI agent);
compatibility matrix documented (02 §9); OAuth is an additive post-gate feature on the
streamable HTTP path (ADR-012), not a rework.

### R5 — Validation risk: accountants may not adopt chat-first tooling (medium, high)

The buyer may want dashboards and files, not an MCP endpoint; TRES already markets an AI
assistant.
**Mitigations:** the demo leads with **artifacts** (close pack CSVs, PDF, balanced journal
drafts) — chat is how you ask, files are what you get; the interview script prices the
artifacts, not the technology; self-host + data-sovereignty pitch differentiates from
SaaS incumbents; the Nuxt dashboard is a planned post-gate answer, and Face B's CSV
in/out flow works without any UI by design.

*Honorable mentions:* GDPR — address-book names and invoice counterparties are PII
(mitigated: tenant-owned tables cascade-delete; self-host keeps data on-prem; document a
DPA template post-gate). Spam-token UX — a wrong default would either hide real funds or
drown the user in scams (mitigated: `verified` + explicit `UNVERIFIED_EXCLUDED` warning +
eval case).

## Open questions (with recommendations)

| # | Question | Recommendation / plan |
|---|---|---|
| Q1 | **Stablecoin valuation policy**: book USDC at peg 1.0 or at market (±0.3%)? Affects journal amounts and matching tolerances. | Default `peg_for_stables` for recon tolerance, `market` for analytics valuation; per-tenant setting exists (ADR-007). Put the question in every validation interview — accountants' convention wins. |
| Q2 | **QBO/Xero: file import vs API push for MVP.** Xero manual-journal CSV import is standard; QBO journal-entry CSV import availability varies by region/edition. | Ship file export (both formats) in weeks 6–8; verify QBO CSV import against a trial account in week 6 — if blocked, start Intuit OAuth app review immediately (lead time is weeks) and treat API push as the QBO path. Architecture is indifferent (exporter port, ADR-013 keeps API connectors closed-source). |
| Q3 | **Internal transfers & Safe wallets: how loud is the demand?** DAOs (a stated audience) live on Safe. | Ask in interviews. If Safe ranks top-2, promote internal-tx stream + Safe address support to the first post-gate milestone; the event model and sentinel space are already shaped for it. |
| Q4 | **Provider/price-source commercial terms** for a public hosted demo (Etherscan V2 free tier, DefiLlama, CoinGecko demo plan). | Re-read ToS before the demo goes public (week 4); fallback: demo on Blockscout + DefiLlama; self-host docs always instruct BYO keys. |
| Q5 | **Anchored-backfill threshold** (50k txs) and UX: who decides, with what wording? | Keep 50k as default; `ledger_track_wallet` already refuses to silently choose (returns `suggests_anchored`). Tune after first real whale onboarding. |
| Q6 | **Close pack for EU firms in Face A**: is EUR valuation needed before Face B ships? | Cheap: valuation currency is already a parameter and ECB rates land in week 2 (pricing). Default the demo to USD; flip per audience. |
| Q7 | **Eval gate strictness**: is majority-of-3 too lenient for the demo video? | Keep the gate at 2/3 majority for iteration speed; record the demo video only from a 3/3 clean run. Post-gate, raise to 3/3 when the model/prompt stabilizes. |

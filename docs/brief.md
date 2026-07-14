# Product Brief (Canonical)

> Source of truth for scope. Distilled from the founding design session (2026-07-14).
> Architecture docs and ADRs reference this file; if scope changes, change it here first.

## One-liner

A self-hostable, MCP-native on-chain ledger for crypto accounting: deterministic ingestion and
computation over EVM wallet activity, exposed to LLM agents through auditable MCP tools.

## Operator context

- Solo developer: senior frontend (Vue 3 / Nuxt 3, React), strong TypeScript/Node backend.
- Capacity: 4–5 h/day, 10–12 weeks to a validation gate.
- Priorities: business logic, system design, architecture. UI is built last.
- The MCP architecture and agent evals deliberately overlap with Claude Certified Architect
  exam material — a planned synergy, not an accident.

## Product: one backend, two faces (built strictly sequentially)

**Core (weeks 1–3).** On-chain ledger: ingestion → normalization → deterministic computation,
with an MCP server on top.

**Face A — first (weeks 4–5). AI/MCP copilot for on-chain analytics & reporting.**
Audience: accounting firms and solo accountants serving crypto clients; finance teams of
crypto companies and DAOs.
MVP: natural-language questions about wallets (balances, inbound/outbound flows, gas,
counterparty turnover, stablecoin movements) and two exports — monthly close pack
(CSV + draft journal entries) and a PDF summary.

**Face B — second (weeks 6–8). Stablecoin payment ↔ invoice reconciliation.**
Audience: EU SMBs, freelancers, and agencies paid in stablecoins.
MVP: invoice import (CSV minimum), many-to-many matching (partial payments, overpayments,
fees), match statuses with manual confirmation, EUR/USD equivalent at payment date,
VAT tagging, journal draft export for QuickBooks/Xero.

**Option C — NOT built.** Tax reconciliation of agentic payments (x402). Only two cheap
seams remain in the architecture for optionality:
1. The matching engine is source-agnostic: `external_record ↔ settlement` pairs, where an
   invoice is just one `kind` of external record (discriminator field), not a hard-coded
   invoice↔transfer link.
2. Chains are configuration: adding a new EVM network (Base is already in the list) touches
   no code.

## Hard architectural principles (constraints, not suggestions)

| # | Principle |
|---|-----------|
| P1 | **The LLM never computes.** All calculations are deterministic TypeScript functions. Money: `NUMERIC` in Postgres, bigint/decimal library in code; floats for monetary values are banned. |
| P2 | **Every figure is traceable.** Any number in an agent answer or report reduces to tx hashes and/or tool-call IDs. Citation is part of the MCP tool contract, not an option. |
| P3 | **Event-sourced ledger.** Append-only `chain_events`; idempotency key = `tx_hash + log_index`; derived views are recomputable from events. |
| P4 | **Idempotent ingestion.** Checkpoints per address/network, safe re-runs, reorgs handled via confirmation depth (finality lag), backfill and live modes. |
| P5 | **Persistent price snapshots.** The exact price used in a computation is stored and referenced — audit reproducibility. ECB rates for EUR equivalents. |
| P6 | **Multi-provider data abstraction** (Blockscout / Etherscan / The Graph / Chainstack): one interface, swappable providers. Motive: provider ToS and pricing risk. |
| P7 | **On-chain strings are hostile input.** Token names, memos, and any chain-sourced data are sanitized before reaching LLM context (prompt-injection-through-data defense). |
| P8 | **MiCA red lines.** Read-only: no private keys, custody, or transaction initiation/execution. Agent guardrail: no personal investment advice ("buy/sell/hold"). Journal entries are drafts for professional review (human-in-the-loop). |
| P9 | **Client secrets.** QuickBooks/Xero OAuth tokens encrypted at rest; secrets never reach logs. |
| P10 | **Self-hosted is a first-class deployment.** docker-compose brings up the whole stack (GDPR sales argument: data never leaves client infrastructure). Schema is multi-tenant (`tenant_id`) from day one; initial deployment is single-tenant. |
| P11 | **MCP-first.** Primary interface is the MCP server (namespaces `analytics.*`, `recon.*`, later `export.*`), attachable to Claude and compatible clients. A thin CLI agent on top for demos and eval runs. Web dashboard (Nuxt) is post-gate. |
| P12 | **Eval harness is mandatory.** Golden-wallet fixtures with known balances and flows; ~30 reference agent questions; property tests over aggregations. |

## MVP scope

**In:**
- Chains: Ethereum + Base (via config; see Option C).
- Events: native transfers + ERC-20 `Transfer`.
- Analytics: balances, flows, gas, counterparty turnover, stablecoin movements; address
  book / counterparty labels.
- Exports: monthly close pack (CSV + draft journal entries), PDF summary.
- Face B: invoice import (CSV minimum), many-to-many matching (partials, overpayments,
  fees), match statuses, manual confirmation, EUR/USD at payment date, VAT tagging,
  QuickBooks/Xero journal export.

**Out (kill list — see ADR-013 consequences and `05-risks-open-questions.md`):**
- DeFi decoding (swaps, LP, lending), staking derivatives, bridges, cross-chain tracing.
- Cost basis / realized P&L — post-gate.
- NFT, non-EVM chains — post-gate.
- Web dashboard — post-gate.
- Custody, payments, KYC, trading — never.

## Tech stack

- Node.js + TypeScript (strict), pnpm. No Python.
- Postgres 16, Drizzle ORM (ADR-002). Redis + BullMQ for ingestion jobs (ADR-008).
- HTTP where needed: minimal Fastify host (ADR-003); validation with Zod v4.
- MCP: official TypeScript SDK. LLM: Anthropic Claude; Agent SDK for the CLI agent and evals.
- Deploy: docker-compose (self-host) + Railway (hosted demo).

## Roadmap

| Weeks | Milestone |
|-------|-----------|
| 1–3 | Core: two-chain ingestion, event ledger, deterministic calc functions, price snapshots. |
| 4–5 | MCP server + CLI agent + eval harness; OSS demo published (repo + video). |
| 6–8 | Face B: invoices, matching, journal export, VAT tagging; landing page. |
| 9–12 | Validation: 8–10 problem interviews (crypto accountants + EU freelancers/agencies with stablecoin invoices), price testing. |

**Gate:** ≥3 LOIs or paid pilots → productization (billing, multi-tenant deploy).
Otherwise the project lives on as portfolio, without SaaS scaffolding.

## Business context (for trade-offs)

- Pre-gate goal: hire-ability and portfolio before MRR. Post-gate optional SaaS:
  ~$49 (solo accountant) / ~$199 (firm, multi-client) / $500+ or one-time license for
  supported self-host.
- Incumbents: Cryptio, Bitwave, Cryptoworth, TRES (the latter already ships an AI assistant).
  Differentiation: self-host, MCP-nativeness, later DeFi/non-EVM depth.
- Licensing hypothesis: open-core — ledger core and MCP server open (portfolio value); SaaS
  scaffolding (billing, multi-tenant deploy, hosted exports) closed. Boundary fixed in ADR-013.

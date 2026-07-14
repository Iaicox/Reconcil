# ADR-013: Open-core boundary & licensing — Apache-2.0 core, `ee/` reserved for SaaS scaffolding

**Status:** accepted · **Date:** 2026-07-14

## Context

Pre-gate the repo is a portfolio artifact (hire-ability first), post-gate possibly a
business. The brief's hypothesis: open the ledger core and MCP server, keep the SaaS
scaffolding closed. The boundary must maximize portfolio value and the self-host/GDPR
pitch without giving away the future paid tier.

## Decision

1. **License: Apache-2.0** for everything public (patent grant → enterprise-friendly;
   expected by the accounting-adjacent buyer more than MIT's brevity).
2. **Open (the self-host product is complete):** `core`, `db`, `ingestion`, `pricing`,
   `ledger`, `recon`, `exporters` (file-based close pack / PDF / QBO-Xero journal CSVs),
   `mcp-tools`, `mcp-server`, `cli`, `evals` incl. fixtures, docker-compose, all docs.
   Rationale: Face B *is* the GDPR/self-host pitch — a closed recon would kill the
   product's main differentiator and halve the portfolio value.
3. **Closed post-gate (`ee/` reserved, empty pre-gate):** billing, tenant provisioning
   and hosted control plane, hosted demo infra, **API-push connectors** for
   QuickBooks/Xero (OAuth flows; the file exporters stay open), premium curated label
   packs, SLA tooling.
   The commercial line: *self-host with files is free; hosted convenience and one-click
   API push are paid.*
4. Pre-gate there is nothing closed to hide: the public repo is the whole repo; `ee/`
   exists as a workspace-excluded directory convention so the split later is a `git mv`,
   not a re-architecture.

## Alternatives considered

- **AGPL core** — stronger copyleft against SaaS-wrapping competitors, but chills the
  exact audience we court (firms self-hosting inside their infra, potential acquirers of
  the developer's time). Portfolio goal favors permissive.
- **BSL/FSL source-available** — solves wrap-risk but is not "open source" for portfolio
  optics; incumbents (Cryptio, Bitwave) are closed — being genuinely open *is* the wedge.
- **Everything open forever** — forfeits the only obvious paid line (hosted + API push)
  before validation says whether it matters.
- **Close reconciliation (Face B)** — rejected: it guts the self-host sales argument and
  the demo story.

## Consequences

- OSS demo (weeks 4–5) publishes the complete working product — maximal portfolio effect.
- Risk accepted: anyone may self-host without paying; the paid tier sells convenience,
  not capability. Consistent with the pre-gate goal (hire-ability > MRR).
- If the gate is not met, nothing needs relicensing — the repo already stands as the
  portfolio piece.

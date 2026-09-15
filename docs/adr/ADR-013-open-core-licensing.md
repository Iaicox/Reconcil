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

   *Amended 2026-09-15 (ADR sweep — accuracy).* Two things worth writing down, because the
   convention is doing less than it sounds like.

   - **Nothing keeps `ee/` empty, and `ee/` is exempt from every gate.** It is referenced in
     exactly two places: a comment in `pnpm-workspace.yaml` (the `packages:` globs simply
     never match it — there is no exclusion directive) and the ESLint ignore list. Code
     dropped there would be invisible to `pnpm lint` (ignored), `pnpm typecheck` (not a
     project reference), `pnpm depcruise` (which cruises `apps packages`) and
     `pnpm check:supply-chain` — so the one directory reserved for the paid tier is the one
     directory where ADR-011's "guardrail claims are literally verifiable from CI" would stop
     being true. Adding it to the gates (or asserting it stays empty) is tracked in
     `09-known-gaps.md`; it costs nothing today because the directory holds only a README.
   - **The connectors' persistence layer already sits in the open half.**
     `integration_credentials` — QuickBooks/Xero OAuth tokens, AES-256-GCM ciphertext/nonce
     with a `key_version` for rotation — is defined in `packages/db`, which d2 lists as open.
     Decision 4 keeps this from being a contradiction of fact (the repo is all public), but
     the boundary as *drawn* is not where the code sits: a later `git mv` of the connectors
     into `ee/` leaves their credential table, encryption envelope and rotation column
     behind. That is arguably the right split — schema is infrastructure, the OAuth flow is
     the product — and saying so now is cheaper than rediscovering it at the move.

   One smaller gap: every workspace package declares `"license": "Apache-2.0"` (13 of 13), but
   `site/` — not a workspace member, not named in d2's open list or d3's closed one — has no
   `license` field. It is not needed to self-host, so d2 holds; d1's "everything public" has
   no per-package field to back it there.

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

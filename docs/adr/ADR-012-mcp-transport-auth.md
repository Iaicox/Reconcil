# ADR-012: MCP transport & auth — stdio for self-host, streamable HTTP + bearer for hosted; OAuth post-gate

**Status:** accepted · **Date:** 2026-07-14 · **Amended:** 2026-08-06 (transport-level
defense in depth — see decision 6)

## Context

Open decision: transports for self-host vs hosted demo, and the tool auth model. Client
reality (mid-2026): Claude Code and Claude Desktop speak stdio to local servers; Claude
Code attaches custom headers to remote servers; claude.ai custom connectors require
OAuth. The MCP spec's remote-auth story is OAuth 2.1 and still evolving.

## Decision

1. **Two entrypoints over one tool registry** (`packages/mcp-tools` is transport-agnostic):
   - `stdio` — the self-host default (Claude Desktop/Code config launches the container
     or a local node process). Auth: none — process trust; the tenant is the single
     self-host tenant, resolved from config.
   - `streamable HTTP` — mounted on the minimal Fastify host (`/mcp`, ADR-003), stateless
     JSON-RPC mode. Used by the hosted demo and optionally by self-host on localhost.
2. **Hosted auth MVP: static bearer keys per tenant** (`Authorization: Bearer …`),
   sha256-hashed in `api_keys`, revocable. The bearer maps request → tenant context;
   tenant identity is never a tool argument (ADR-006). Rationale: Claude Code (`--header`)
   and the Agent SDK support it; it is sufficient for a gated demo.
3. **OAuth 2.1 is the post-gate upgrade**, required for claude.ai custom connectors; it
   slots in front of the same streamable HTTP transport (resource-server metadata +
   token validation) without touching tools. Documented as a compatibility gap in the
   client matrix (02 §9) so demos are planned around stdio/Code paths.
4. **In-process transport for evals/CLI**: the Agent SDK binds tool functions directly —
   no server process in the eval loop, deterministic and fast.
5. **Tool naming**: wire names use underscores (`analytics_balances`); dots break the
   Claude API's tool-name constraint (`^[a-zA-Z0-9_-]+$`). Namespaces are conventions.
6. **Transport-level defense in depth, layered on top of bearer auth (2026-08-06).** Two
   protections that don't change the auth model itself, added to the streamable-HTTP
   entrypoint:
   - **DNS-rebinding protection.** `StreamableHTTPServerTransport` is constructed with
     `enableDnsRebindingProtection: true` plus a `Host`-header allowlist
     (`resolveAllowedHosts`, `apps/mcp-server/src/config.ts`); `RECONCIL_ALLOWED_HOSTS`
     overrides it, unset defaults to the localhost/127.0.0.1/compose-service-name forms at
     the configured port.
   - **Two-layer rate limiting** (`apps/mcp-server/src/http.ts`). A per-IP backstop runs at
     Fastify's `onRequest` stage, before auth and before any DB work, so it catches a
     request regardless of credential validity. A per-tenant fairness bucket runs from the
     auth `preHandler`, reachable only once `authenticate()` has resolved a DB-verified
     tenant. This replaced a single limiter keyed on the *presented* (unverified) bearer
     token: rotating a fresh garbage `Authorization` header per request landed each one in
     a new bucket, so the limit never tripped while every request still paid for a live
     `resolveTenantByBearer` DB lookup — unbounded 401 + query amplification per IP.
   - A hijacked transport's own request-handling failure is always caught and answered
     (`handleHijackedTransport`) — no unhandled rejection can leave a hijacked socket open
     indefinitely.

## Alternatives considered

- **stdio only** — no hosted demo, no remote clients; fails the demo requirement.
- **HTTP only** — needless friction for self-host desktop users (the majority persona),
  and stdio is the most battle-tested client path.
- **OAuth from day one** — weeks of auth plumbing before there is anything worth
  protecting; delivers claude.ai-web reach that the demo plan does not need yet.
- **Stateful HTTP sessions** — server-side session affinity complicates the hosted
  deployment for zero MVP benefit; stateless mode keeps Railway trivial.

## Consequences

- Demo paths (Claude Code stdio/HTTP, Desktop stdio, CLI agent) all work at MVP.
- claude.ai web connectors explicitly do not work until OAuth lands — known, documented,
  planned.
- Bearer keys are demo-grade: no scopes, no expiry (only revocation). Acceptable for a
  gated demo; not for production multi-tenant (gate criterion for the OAuth work).

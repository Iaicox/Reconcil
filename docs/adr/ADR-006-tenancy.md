# ADR-006: Tenancy — global chain data, tenant-owned tracking; repository-layer scoping

**Status:** accepted · **Date:** 2026-07-14

## Context

P10: multi-tenant schema from day one, single-tenant deployment at start, self-host as a
GDPR argument. The naive reading — `tenant_id` on every table — collides with the nature
of the data: chain events and prices are public facts, identical for everyone.

## Decision

1. **Two-zone schema.** Global (no tenant): `tokens`, `chain_events`, `price_snapshots`,
   `fx_rates`, `ingestion_checkpoints`. Tenant-owned: `wallets`, `clients`, `entities`
   (+`entity_addresses`; `tenant_id NULL` = curated seed labels), `external_records`,
   `matches`, `tool_calls`, `integration_credentials`, `exports`, `api_keys`.
   The tenant boundary is *what you track and how you label it*, not the public data.
2. **Scoping at the tool layer, over a tenant-resolved address set.** MCP tools receive
   tenant identity from the transport session (ADR-012), never from tool arguments.

   *Amended 2026-09-15 (ADR sweep — accuracy).* This said "Every repository method takes a
   tenant context; event queries always join through the tenant's `wallets`". Neither half
   describes the code. `packages/ledger/src` contains **zero** occurrences of `tenantId`:
   every method there takes `(db, params)` where the scope is an already-resolved `string[]`
   of addresses, and the predicate is an `inArray` over that materialised list rather than a
   join — in several shapes depending on what the query means: a single-sided
   `inArray(toAddr, …)` or `inArray(fromAddr, …)` for the two halves of a balance,
   `or(…)` where either endpoint counts, and `externalCondition`'s
   `or(and(toIn, fromOut), and(fromIn, toOut))` in `scope-sql.ts` where the question is
   "exactly one endpoint is ours" (that last one is deliberate — the plain `or` over-counted
   wallet-to-wallet moves, fixed in PR #23). The tenant property is derived exactly one
   layer up, in `resolveScope` (`packages/mcp-tools/src/scope.ts`), which selects `wallets`
   filtered by `ctx.tenantId`; `recon` re-derives the same set inside its own tenant-scoped
   transaction.

   That is a defensible layering — the ledger is a pure query package over global chain data
   — but the invariant it actually holds is weaker than the one stated: *"every CALLER of a
   ledger method must have resolved its address set from the tenant's wallets."* Nothing
   enforces it. `@reconcil/ledger` is an exported workspace package whose public API cannot
   express tenancy, so a future caller that assembles addresses another way type-checks
   fine. Every current caller does route through `resolveScope`, verified tool by tool; the
   missing enforcement is tracked in `09-known-gaps.md`.

   The tenant-owned repositories (`recon`, `directory`, audit) DO take a tenant context and
   predicate on it — with one exception, `directory_upsert_entity`'s `client_id`, recorded in
   `09-known-gaps.md`.
3. **`clients`** sub-scope inside a tenant models an accounting firm's portfolio
   (the $199 multi-client tier): wallets, records, and exports partition per client.
4. **RLS deferred** post-gate: with single-tenant deployments and one code path to the DB,
   Postgres row-level security adds policy complexity now and pays off only for hosted
   multi-tenant — where it will be added *on the tenant-owned tables* without schema change.

## Alternatives considered

- **`tenant_id` on everything incl. events** — duplicate ingestion & storage when two
  tenants track one address (same accounting firm's clients pay twice in provider quota);
  events must then be copied on wallet-add; no benefit until hosted multi-tenant, and even
  then the join-through-wallets model holds.
- **RLS from day one** — attractive on paper; in practice every migration and test grows
  policy ceremony while the MVP runs single-tenant. Deliberately sequenced later.
- **Schema-per-tenant** — operationally heavy (migrations × tenants), kills the shared
  public-data zone; wrong shape for this product.

## Consequences

- Shared checkpoints: adding an already-tracked address is instant for the second tenant.
- Tenant deletion = cascade over ownership tables; public data legitimately remains. In the
  DATABASE, PII (labels, invoices) lives only in tenant-owned tables, all ten of which
  declare `ON DELETE CASCADE` — so the erasure story holds for everything Postgres owns.

  *Amended 2026-09-15 (ADR sweep — accuracy).* It used to say PII lives only in tenant-owned
  tables, full stop, which is not true of the deployment. Exports write invoice references and
  counterparty names into **files on disk**; the `exports` row holds a `file_path` pointing at
  them (alongside `params` and `manifest` jsonb) rather than the content itself, so the
  cascade removes the pointer and leaves the files. A tenant deletion therefore erases
  the database and not the close packs, PDFs and journal drafts under the export root. Closing
  it means deleting or scrubbing an export directory on cascade, which is a code change and is
  tracked in `09-known-gaps.md`.
- The cross-tenant isolation guarantee rests on the repository layer until RLS lands —
  acceptable while deployments are single-tenant; revisit at hosted multi-tenant
  (tracked in ADR-013 consequences).

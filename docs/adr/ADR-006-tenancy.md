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
2. **Scoping in the repository layer.** Every repository method takes a tenant context;
   event queries always join through the tenant's `wallets`. MCP tools receive tenant
   identity from the transport session (ADR-012), never from tool arguments.
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
- Tenant deletion = cascade over ownership tables; public data legitimately remains.
  PII (labels, invoices) lives only in tenant-owned tables — clean GDPR erasure story.
- The cross-tenant isolation guarantee rests on the repository layer until RLS lands —
  acceptable while deployments are single-tenant; revisit at hosted multi-tenant
  (tracked in ADR-013 consequences).

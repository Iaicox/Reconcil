# Tool cheat sheet

All 19 MCP tools at a glance. **This is an index, not a specification.** Input and output
schemas live in [`../architecture/02-mcp-contracts.md`](../architecture/02-mcp-contracts.md)
§6, and the Zod schemas in `packages/core` are the source of truth behind that document.
Nothing here restates a schema, so nothing here can drift out of sync with one.

The one-line purposes below are the *actual* descriptions your MCP client sees — they are
copied from `packages/mcp-tools/src/descriptions.ts`, which the server publishes verbatim in
its tool declarations.

Wire names use underscores (`analytics_balances`), never dots — the Claude API constrains
tool names to `^[a-zA-Z0-9_-]+$`. The `analytics.*` / `recon.*` namespaces are a naming
convention only (ADR-012).

## Analytics — read-only ledger questions (contract §6.1)

| Tool | Mode | Purpose |
|---|---|---|
| `analytics_balances` | read | Token balances per wallet at a point in time, optionally valued in fiat. |
| `analytics_flows` | read | Inbound/outbound/net token movements over a period, always per token, subdivided by optional `group_by` dimensions. |
| `analytics_gas` | read | Gas fee spend over a period, always per chain, subdivided by optional `group_by` dimensions. |
| `analytics_stablecoin_movements` | read | Token flows restricted to verified stablecoins, with per-peg subtotals. |
| `analytics_counterparties` | read | Turnover per counterparty over a period, reported per token, with address-book labels. |
| `analytics_list_events` | read | Enumerate the individual chain events backing any figure — the drilldown and audit primitive. |

## Ledger — coverage, onboarding, audit (contract §6.2)

| Tool | Mode | Purpose |
|---|---|---|
| `ledger_status` | read | Data freshness and completeness per wallet/chain/stream — the "can I trust this answer" check. |
| `ledger_trace_tool_call` | read | Replay the full provenance (coverage, events, prices) of a previously returned answer by its `tool_call_id`. |
| `ledger_track_wallet` | **write** | Begin tracking a wallet: seed ingestion checkpoints and enqueue backfill (full or anchored). |

## Directory — address book (contract §6.3)

| Tool | Mode | Purpose |
|---|---|---|
| `directory_list_entities` | read | List address-book entities (labels for addresses) visible to the tenant. |
| `directory_upsert_entity` | **write** | Create or update a tenant-owned address-book entity and its address labels. |

## Reconciliation — Face B (contract §6.4)

| Tool | Mode | Purpose |
|---|---|---|
| `recon_import_invoices` | **write** | Import invoices from a CSV into external records, idempotently per client. |
| `recon_suggest_matches` | **write** | Run the deterministic matching engine over open records and on-chain settlements and persist its DRAFT suggestions. |
| `recon_confirm_match` | **write** | Confirm one suggested match leg, carrying through its pinned valuation; re-derives the record status. |
| `recon_reject_match` | **write** | Reject one suggested match leg; it stops counting toward the record, the event, and every export. |
| `recon_status` | read | The authoritative reconciliation snapshot: counts by status, open amounts, unreconciled settlements, overpayments. |

## Exports — files (contract §6.5)

| Tool | Mode | Purpose |
|---|---|---|
| `export_close_pack` | **write** | Monthly close pack (opening/closing balances, transactions, gas, counterparty summary, DRAFT journal) as CSVs plus an audit manifest. |
| `export_pdf_summary` | **write** | One-page PDF summary of the month (portfolio value, net flows, gas, top counterparties), labeled DRAFT, plus an audit manifest. |
| `export_journal_drafts` | **write** | QuickBooks/Xero manual-journal CSV DRAFT from the period's CONFIRMED matches only. |

## What "write" means here

Nine tools carry `readOnlyHint: false`. **None of them carries `destructiveHint: true`, and
none of them can** — the product is read-only against the blockchain by construction (P8,
ADR-011): no signing library, no key material, and no transaction construction exists anywhere
in the dependency tree, enforced by a dependency-cruiser rule and a lockfile scan in CI.

A "write" tool writes to *your own database or your own disk*:

- `ledger_track_wallet`, `directory_upsert_entity`, `recon_*` — rows in your Postgres.
- `export_*` — files in your exports directory, plus a row in the `exports` table.

`chain_events` is append-only and never updated or deleted by anything (ADR-005).

## Every response has the same shape

Whatever the tool, the response is a `ToolEnvelope`:

```
{ data, citations: { tool_call_id, coverage, event_refs | event_ref_summary,
                     price_refs, fx_refs }, warnings, meta }
```

- **`data`** — the figures. Money is always a decimal *string*, never a float (ADR-004).
- **`citations`** — where each figure came from. `tool_call_id` is persisted before the
  response is returned, so `ledger_trace_tool_call` can replay it months later.
- **`warnings`** — machine-readable caveats the agent must surface. See
  [Operations → Warnings](05-operations.md#warnings-what-they-mean-for-you).
- **`meta`** — schema version, computation timestamp, units.

The invariants that make this trustworthy (C1–C6) are specified in contract §3. The short
version: no number without provenance, no fiat value without a pinned price snapshot, no
silent gaps in coverage.

## Related

- [Face A — analytics and reporting](03-face-a-analytics.md) — the analytics, ledger, directory, and export tools in a workflow.
- [Face B — reconciliation](04-face-b-reconciliation.md) — the recon tools in a workflow.
- [Tool contracts](../architecture/02-mcp-contracts.md) — the full schemas.

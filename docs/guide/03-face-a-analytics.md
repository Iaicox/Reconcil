# Face A — analytics and reporting

For accountants and finance teams who need to answer questions about on-chain wallet
activity and hand a defensible pack to a reviewer.

The workflow: **track → wait for coverage → ask → label → export → prove**.

Every response on this page came from a live stack.

## 1. Track the wallets

```json
{ "name": "ledger_track_wallet",
  "arguments": { "address": "0xabc…", "label": "Ops wallet", "client_id": "<uuid>" } }
```

- `client_id` scopes the wallet to one of your sub-clients (relevant if you are a firm
  serving several). Omit it for a single-business deployment.
- Both chains and both event streams are seeded by default. Restrict with
  `chains: [1]` if you only care about Ethereum.
- Idempotent: re-tracking returns the same `wallet_id` and enqueues nothing.

**Large wallets.** Full history is the default. For a wallet with a very large transaction
count, the worker's asynchronous probe raises a flag on `ledger_status`:

```json
"estimate": { "tx_count_hint": 128000, "suggests_anchored": true }
```

That is a prompt for *you*, not an automatic decision (the tool never silently truncates
history). If you accept it, re-track with an opening baseline:

```json
{ "address": "0xabc…", "mode": "anchored", "anchored_from": "2026-01-01" }
```

The worker writes an `opening_balance` event at the resolved anchor block and ingests
forward from there. Answers built on it carry an `ANCHORED_BASELINE` warning forever —
honest by design. See [Operations → Backfill modes](05-operations.md#backfill-full-vs-anchored).

## 2. Check coverage before trusting a number

```json
{ "name": "ledger_status", "arguments": {} }
```

Per wallet, per chain, per stream: `status`, `last_processed_block`, `last_block_time`,
`backfill_progress`, `last_error`. `status: "live"` means the stream is caught up to
`head − finality_depth` and safe to quote.

Do not skip this step at month-end. Every analytics answer carries the same coverage in its
citations, but `ledger_status` is where you look *first*.

## 3. Ask the questions

Six read-only tools cover the accountant's standard set. Ask in natural language; the agent
picks the tool. The tool calls are shown so you know what is happening underneath.

### Balances — "what did we hold on 30 June?"

```json
{ "name": "analytics_balances",
  "arguments": { "as_of": "2026-06-30", "valuation": { "currency": "EUR" } } }
```

`as_of` resolves to the last finalized ingested block whose time is at or before the end of
that UTC day, and the resolved (block, date) pair is echoed back in `as_of_effective` — so
"the balance on 30 June" is a defined, citable quantity rather than a moving target.

### Flows — "what moved in and out last month?"

```json
{ "name": "analytics_flows",
  "arguments": { "period": { "from": "2026-06-01", "to": "2026-06-30" },
                 "group_by": ["counterparty"] } }
```

```json
{ "data": {
    "rows": [ { "group": { "token": "EURC", "chain_id": "1" },
                "inflow": "2910", "outflow": "500", "net": "2410", "tx_count": 5 } ],
    "internal_transfers": [] } }
```

Two things to internalize:

- **Every row is per token, per chain.** Raw base units of a 6-decimal and an 18-decimal
  token cannot be added (ADR-004), so `group_by` *subdivides* rows; it never merges tokens.
  `group` always carries `chain_id`, so same-symbol tokens on different chains stay apart.
- **`internal_transfers` is a separate array.** Moves between two wallets you track are not
  income and not spending. Reporting them as flow is the classic crypto-accounting error;
  here they are structurally impossible to double-count.

### Gas — "what did fees cost us?"

```json
{ "name": "analytics_gas",
  "arguments": { "period": { "from": "2026-06-01", "to": "2026-06-30" },
                 "group_by": ["month"], "valuation": { "currency": "EUR" } } }
```

Rows are always per chain (the fee token is per chain). Gas is stored as its own event
kind, so it folds through the same machinery as any transfer.

### Stablecoin movements — "how much EURC came in?"

```json
{ "name": "analytics_stablecoin_movements",
  "arguments": { "period": { "from": "2026-06-01", "to": "2026-06-30" } } }
```

```json
{ "data": {
    "rows": [ { "group": { "token": "EURC", "chain_id": "1" },
                "inflow": "2910", "outflow": "500", "net": "2410", "tx_count": 5 } ],
    "internal_transfers": [],
    "peg_subtotals": [ { "peg_currency": "EUR", "inflow": "0", "outflow": "0" } ] } }
```

Verified stablecoins only. There is no `valuation` input — the fiat story is
`peg_subtotals`, face value under peg policy, pinned by a synthetic `source: 'peg'` price
reference.

> In the run above the subtotals are `0` because the demo database has no peg snapshot for
> that token — the tool omits the value instead of inventing one. On a stack whose worker has
> filled prices, they carry the real face-value sums.

### Counterparties — "who did we transact with?"

```json
{ "name": "analytics_counterparties",
  "arguments": { "period": { "from": "2026-06-01", "to": "2026-06-30" }, "top_n": 20 } }
```

```json
{ "data": {
    "rows": [
      { "counterparty": { "kind": "entity", "entity_id": "ef93a08e-…",
                          "name": "Acme GmbH", "entity_kind": "client", "curated": false },
        "tx_count": 4, "tokens": ["EURC"],
        "per_token": [ { "token": { "symbol": "EURC", "decimals": 6, … },
                         "inflow": "2910", "outflow": "0" } ] },
      { "counterparty": { "kind": "address", "address": "0x9999…9999" },
        "tx_count": 1, "tokens": ["EURC"],
        "per_token": [ { "token": { "symbol": "EURC", … }, "inflow": "0", "outflow": "500" } ] }
    ],
    "unlabeled_share": { "tx_count": 1, "hint": "directory_upsert_entity" } } }
```

Turnover is per token for the same reason flows are. `unlabeled_share` counts the still-anonymous
addresses among the counterparties returned — the ones worth naming first.

### Events — "show me exactly which transactions"

```json
{ "name": "analytics_list_events",
  "arguments": { "period": { "from": "2026-06-01", "to": "2026-06-30" }, "limit": 50 } }
```

```json
{ "chain_id": 1, "tx_hash": "0xa1a1…", "log_index": 0, "kind": "erc20_transfer",
  "block_number": 100, "block_time": "2026-06-10T10:00:00.000Z",
  "token": { "symbol": "EURC", "decimals": 6, "is_stablecoin": true,
             "peg_currency": "EUR", "verified": true },
  "amount": "1000", "amount_raw": "1000000000",
  "from": { "address": "0x2222…" }, "to": { "address": "0x1111…" }, "direction": "in" }
```

This is the drilldown target for the whole system. `amount` is display units, `amount_raw` is
base units; `direction` distinguishes `in` / `out` / `internal`. Page with `cursor`;
`total_count` comes on the first page only.

## 4. Label the addresses

An unnamed counterparty is useless in a report. The address book fixes that:

```json
{ "name": "directory_upsert_entity",
  "arguments": { "name": "Acme GmbH", "kind": "client",
                 "addresses": [ { "chain_id": 1, "address": "0x2222…" } ] } }
```

```json
{ "data": { "entity_id": "ef93a08e-2d66-49c6-8a69-85963a75f355", "created": true } }
```

Re-run `analytics_counterparties` and that address is now `"name": "Acme GmbH"` — as shown
above. The tool never invents a name: it reports what is unlabeled, the agent proposes, you
confirm.

`kind` is one of `self · client · vendor · exchange · contract · employee · other`.
Curated (built-in) entities are read-only; editing one returns `INVALID_INPUT`.

## 5. Export the month

### Close pack — seven files

Every filename carries the period, so two months copied into one folder never overwrite
each other: a calendar month collapses to `YYYY-MM` (as below); any other period spells
out both ends, `<start>_<end>`.

```json
{ "name": "export_close_pack",
  "arguments": { "month": "2026-06", "valuation": { "currency": "EUR" } } }
```

```json
{ "data": {
    "export_id": "fc61ec41-a2fd-476f-9ae4-664e6d00af29",
    "kind": "close_pack",
    "period": { "start": "2026-06-01", "end": "2026-06-30" },
    "files": [
      { "name": "balances_opening_2026-06.csv",     "sha256": "3501fb55…" },
      { "name": "balances_closing_2026-06.csv",     "sha256": "dd398f08…" },
      { "name": "transactions_2026-06.csv",         "sha256": "12310983…" },
      { "name": "gas_2026-06.csv",                  "sha256": "1516f1b0…" },
      { "name": "counterparty_summary_2026-06.csv", "sha256": "f4c59582…" },
      { "name": "journal_draft_2026-06.csv",        "sha256": "922484d9…" },
      { "name": "manifest.json",                    "sha256": "1bb79508…" } ] },
  "warnings": [
    { "code": "COVERAGE_INCOMPLETE", … },
    { "code": "PRICE_MISSING", "message": "no price snapshot for token 1 on 2026-06-30",
      "context": { "tokenId": 1, "date": "2026-06-30", "currency": "EUR" } },
    { "code": "UNVERIFIED_EXCLUDED", … } ] }
```

**Read the warnings before you send the pack to anyone.** The run above is missing a price
snapshot for the closing date, so the fiat column is omitted rather than guessed, and the
ledger was still backfilling. Both are disclosed, neither is silently papered over.

### PDF summary

```json
{ "name": "export_pdf_summary",
  "arguments": { "month": "2026-06", "valuation": { "currency": "EUR" } } }
```

Produces `summary.pdf` + `manifest.json` — a one-page portfolio/flows/gas/counterparty
overview, labeled DRAFT.

### The manifest is the point

Every export writes a `manifest.json` next to its files:

```json
{
  "schema_version": 1,
  "export_id": "fc61ec41-…",
  "tool_call_id": "01KYMK0R49BKY2PG37Q6QZ2JVT",
  "kind": "close_pack",
  "period": { "start": "2026-06-01", "end": "2026-06-30" },
  "currency": "EUR",
  "scope": { "addresses": ["0x…dead", "0x1111…"] },
  "generated_at": "2026-07-28T14:45:47.785Z",
  "draft": true,
  "coverage": [ … ],
  "price_refs": [], "fx_refs": [],
  "rounding_residues": [ { "currency": "EUR", "residue": "0.00" } ],
  "files": [ { "name": "balances_opening_2026-06.csv", "sha256": "3501fb55…" }, … ]
}
```

Which wallets, which blocks, which prices, which tool call, and a hash of every file. Hand
the pack to an auditor and the manifest answers "where did this come from" without you in
the room.

`journal_draft_2026-06.csv` opens with a banner row: `DRAFT — REVIEW REQUIRED`. Journal
artifacts are drafts for professional review, never filings (P8).

### Getting the files off the stack

Exports are written inside the container, to the `exports` volume:

```bash
docker compose cp mcp-server:/app/exports ./exports
```

```
reconcil-mcp-server-1 Copied reconcil-mcp-server-1:/app/exports to ./exports
```

```
exports/
  fc61ec41-a2fd-476f-9ae4-664e6d00af29/
    balances_opening_2026-06.csv  balances_closing_2026-06.csv  transactions_2026-06.csv
    gas_2026-06.csv  counterparty_summary_2026-06.csv  journal_draft_2026-06.csv  manifest.json
```

One directory per `export_id`. To write somewhere else, set `RECONCIL_EXPORT_DIR` or pass
`out_dir` on the call ([Operations → Exports](05-operations.md#exports-on-disk)).

## 6. Prove where a number came from

Months later, someone asks about a figure in that pack. Take the `tool_call_id` from the
manifest (or from any earlier answer) and replay it:

```json
{ "name": "ledger_trace_tool_call",
  "arguments": { "tool_call_id": "01KYMK31D83DSAXDABMG57G7YA" } }
```

```json
{ "data": {
    "tool_name": "analytics_list_events",
    "args": { "limit": 3, "period": { "from": "2026-06-01", "to": "2026-06-30" } },
    "called_at": "2026-07-28T14:47:02.813Z",
    "coverage": [ { "chain_id": 1, "address": "0x…dead", "status": "backfilling",
                    "from_block": null, "to_block": 0, "streams": ["erc20","native"] }, … ],
    "result_digest": "e33c6b5fdd7262ced035d6036f808ce9ebaecad16c15832a61e3d4336e453038" } }
```

The exact call, the exact ledger slice, and a digest of the exact result. This works across
sessions because the `tool_call_id` is persisted *before* the response is returned — it is a
contract invariant (C2), not a logging convenience.

An unknown id is rejected rather than fudged:

```json
{ "code": "INVALID_INPUT", "message": "tool_call_id not found: 01JZZZZZZZZZZZZZZZZZZZZZZZ" }
```

## What the agent will not do

- **It will not compute.** Every figure comes from a deterministic function over the event
  store. If a number is in the answer, a tool produced it (P1).
- **It will not advise.** Ask whether to sell your ETH and it declines and redirects. Tools
  return facts, never judgments — no "performance", no "recommendation" (P8).
- **It cannot transact.** No signing library, no key material, no transaction construction
  exists anywhere in the dependency tree, and CI fails if one appears (ADR-011).
- **It does not trust chain strings.** Token names and memos are sanitized and delivered
  only under `untrusted` keys, with an explicit instruction to treat them as data. A token
  named "ignore previous instructions" is inert text.

## Next

- [Face B — reconciliation](04-face-b-reconciliation.md) — match those inbound payments to invoices.
- [Operations](05-operations.md) — warnings, backfill, troubleshooting.
- [Tool contracts](../architecture/02-mcp-contracts.md) — full input/output schemas.

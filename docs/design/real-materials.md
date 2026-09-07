# Reconcil — real materials for the landing design

> Companion to [`landing-brief.md`](landing-brief.md). Assembled 2026-07-28.
> Everything below is **verbatim** from an artifact that exists in this repository, with the
> source path next to it. Nothing here was written for the landing page.

The page has no product screenshot to show ([brief §7](landing-brief.md)), and §6 forbids
inventing one. These are the real objects the design can put on screen instead. Use them as
they are.

---

## 0. Rules for using this pack

1. **Quote, do not compose.** Each block came from one run of one tool. Splicing two blocks
   into a single plausible-looking response produces a fabricated artifact — exactly the thing
   the product claims it never does, on the page that claims it.
2. **Do not tidy the numbers.** `0.37857142857142856` is the real confidence. Round it in the
   render if the layout needs to (`0.379`), never in the source of truth.
3. **Caption the fixture as a fixture.** The addresses (`0x1111…`) and tx hashes (`0xa1a1…`)
   are the repository's demo fixture, not mainnet. Say so — *"figures from the repository's
   demo fixture, reproducible by anyone who runs the stack"* is a stronger claim than a
   real-looking hash nobody can tie to this product.
4. **Field names are contract, not copy.** `tool_call_id`, `coverage`, `event_refs`,
   `price_refs`, `warnings` appear exactly like that in every response
   ([`../architecture/02-mcp-contracts.md`](../architecture/02-mcp-contracts.md) §2). A design
   that renames them stops matching what a user would see.
5. **Assistant prose does not exist in captured form.** See §7 below before drawing a
   conversation.

---

## 1. The fixture everything ties back to

Source: [`../../packages/evals/src/seed-recon.ts`](../../packages/evals/src/seed-recon.ts) —
the seeded scenario behind every Face B response on this page. Keep visuals consistent with
these numbers.

| | |
|---|---|
| Tenant wallet | `0x1111…1111` |
| Payer (customer) | `0x2222…2222` |
| Vendor | `0x9999…9999` |
| Token | EURC — 6 decimals, `verified`, `is_stablecoin`, peg `EUR` |
| Client | Acme Client, base currency EUR |

| Record | Direction | Amount | VAT | Settled | Status |
|---|---|---|---|---|---|
| `INV-PAID` | receivable | 1 000.00 EUR | — | 1 000 on 2026-06-10 | matched |
| `INV-VAT` | receivable | 1 210.00 EUR | 21% | 1 210 on 2026-06-11 | matched |
| `INV-PARTIAL` | receivable | 1 000.00 EUR | — | 400 on 2026-06-12 | partially matched |
| `INV-OPEN` | receivable | 300.00 EUR | — | 300 on 2026-06-13 | open until confirmed |
| `BILL-OPEN` | payable | 500.00 EUR | — | 500 on 2026-06-14 | open until confirmed |

A same-currency stablecoin settles at **face value** — 300 EURC against a 300.00 EUR invoice,
reproducible as amount × 1, no price snapshot involved.

---

## 2. The output artifact — a journal draft

Source: [`../guide/04-face-b-reconciliation.md`](../guide/04-face-b-reconciliation.md) §6.
The export response first:

```json
{ "data": { "export_id": "bfd25c08-…",
            "file": { "name": "journal_draft_qbo_2026-06_DRAFT.csv",
                      "path": "/app/exports/bfd25c08-…/journal_draft_qbo_2026-06_DRAFT.csv",
                      "sha256": "9f62c3a4828fe1debf1455b1b66028929048c32179d43df4ec088414631fb212" },
            "lines": 9, "unmapped_categories": [], "balanced": true } }
```

The file:

```csv
*JournalNo,*JournalDate,*AccountName,Debits,Credits,Description,Currency
DRAFT — REVIEW REQUIRED,,,,,,
1,2026-06-10,1010,1000.00,0.00,INV-PAID — ACME GmbH,EUR
1,2026-06-10,1200,0.00,1000.00,INV-PAID — ACME GmbH,EUR
2,2026-06-11,1010,1210.00,0.00,INV-VAT — ACME GmbH,EUR
2,2026-06-11,1200,0.00,1000.00,INV-VAT — ACME GmbH,EUR
2,2026-06-11,2200,0.00,210.00,INV-VAT — ACME GmbH,EUR
3,2026-06-12,1010,400.00,0.00,INV-PARTIAL — Beta Ltd,EUR
3,2026-06-12,1200,0.00,400.00,INV-PARTIAL — Beta Ltd,EUR
4,2026-06-13,1010,300.00,0.00,INV-OPEN — Gamma SA,EUR
4,2026-06-13,1200,0.00,300.00,INV-OPEN — Gamma SA,EUR
```

**What a designer should know about this file.** Entry 2 is the one worth enlarging: a €1 210
settlement against a 21% VAT invoice splits three ways — debit crypto asset 1 210, credit
receivables 1 000 (the net), credit VAT output 210. Net is `gross × 100 / (100 + rate)`. Debits
equal credits per currency, guaranteed. Row 2 of the file is the literal banner
`DRAFT — REVIEW REQUIRED`, the filename ends `_DRAFT.csv`, and the manifest records
`"draft": true` — these artifacts are prepared for professional review, never filings.

The banner and the `_DRAFT` suffix are the natural home for the page's one warm accent.

---

## 3. The citation envelope

The shape every tool returns. Source:
[`../architecture/02-mcp-contracts.md`](../architecture/02-mcp-contracts.md) §2 — the contract,
not a sample:

```ts
interface ToolEnvelope<T> {
  data: T;                          // every monetary value is a DecimalString
  citations: {
    tool_call_id: string;           // ULID; persisted to tool_calls BEFORE responding
    coverage: CoverageRef[];        // the ledger slice this answer is computed from
    event_refs?: EventRef[];        // individual events backing the figures (≤ 64)
    price_refs?: PriceRef[];        // every (token, date) price used in valuation
    fx_refs?: FxRef[];              // every FX rate used
  };
  warnings: Warning[];              // machine-readable; agent MUST surface these
  meta: { schema_version: 1; computed_at: string; units: 'decimal-string' };
}

interface EventRef { chain_id: number; tx_hash: string; log_index: number; }
```

A real one, captured. Source: [`../guide/01-quickstart.md`](../guide/01-quickstart.md) §5:

```json
{
  "data": { "wallet_id": "e56947aa-253e-4956-8ddf-a34af7dc6e96", "enqueued": [ … ] },
  "citations": { "tool_call_id": "01KYMJZ1WZ3A6NRYW46EJR5RZ3", "coverage": [] },
  "warnings": [],
  "meta": { "schema_version": 1, "computed_at": "…", "units": "decimal-string" }
}
```

And the object a figure unfolds *into* — one event row from `analytics_list_events`. Source:
[`../guide/03-face-a-analytics.md`](../guide/03-face-a-analytics.md) §3:

```json
{ "chain_id": 1, "tx_hash": "0xa1a1…", "log_index": 0, "kind": "erc20_transfer",
  "block_number": 100, "block_time": "2026-06-10T10:00:00.000Z",
  "token": { "symbol": "EURC", "decimals": 6, "is_stablecoin": true,
             "peg_currency": "EUR", "verified": true },
  "amount": "1000", "amount_raw": "1000000000",
  "from": { "address": "0x2222…" }, "to": { "address": "0x1111…" }, "direction": "in" }
```

This is the drilldown target for the whole system: `amount` is display units, `amount_raw` is
base units, `direction` is `in` / `out` / `internal`.

### Warnings are part of the artifact

Not an error state — a disclosure. Real, from a run where the backfill had not finished:

```json
"warnings": [
  { "code": "COVERAGE_INCOMPLETE", "message": "a wallet/stream in scope is still backfilling or errored" },
  { "code": "UNVERIFIED_EXCLUDED", "message": "unverified (spam-suspected) tokens were excluded; pass include_unverified to include them" }
]
```

`PRICE_MISSING` is the one worth showing on the page: when no price snapshot exists, the fiat
value is **omitted rather than guessed**. A visual that renders a warning as information rather
than as a failure is on-message.

---

## 4. The strongest single visual — proving a number months later

Source: [`../guide/03-face-a-analytics.md`](../guide/03-face-a-analytics.md) §6. Take a
`tool_call_id` from any earlier answer or from an export manifest and replay it:

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
                    "from_block": null, "to_block": 0, "streams": ["erc20","native"] } ],
    "result_digest": "e33c6b5fdd7262ced035d6036f808ce9ebaecad16c15832a61e3d4336e453038" } }
```

The exact call, the exact ledger slice, a digest of the exact result — across sessions, because
the id is persisted *before* the response is returned. An unknown id is refused, not fudged:

```json
{ "code": "INVALID_INPUT", "message": "tool_call_id not found: 01JZZZZZZZZZZZZZZZZZZZZZZZ" }
```

---

## 5. The engine proposes, the model does not score

Source: [`../guide/04-face-b-reconciliation.md`](../guide/04-face-b-reconciliation.md) §3. One
suggestion, trimmed to the fields a visual would use:

```json
{ "match_id": "a35416c3-9c2a-45a1-9ca1-04298ad68bad",
  "record": { "external_ref": "INV-OPEN", "amount": "300.00", "currency": "EUR",
              "open_amount": "300" },
  "event": { "chain_id": 1, "tx_hash": "0xa4a4…", "log_index": 0,
             "token": { "symbol": "EURC", "decimals": 6, "is_stablecoin": true,
                        "peg_currency": "EUR", "verified": true },
             "amount": "300", "block_time": "2026-06-13T10:00:00.000Z",
             "from": { "address": "0x2222…" } },
  "amount_applied": "300", "fiat_value": "300",
  "confidence": 0.37857142857142856,
  "rationale": [
    { "rule": "amount", "weight": 0.35,   "detail": "valued 300 vs open 300 EUR" },
    { "rule": "date",   "weight": 0.0285, "detail": "within 12d of the reference date" } ] }
```

**`confidence` is literally `Σ rationale.weight`** — it adds up by hand, which is the whole
point and a rare thing to be able to show. The rule table:

| Rule | Max weight | Fires on |
|---|---|---|
| `amount` | 0.35 | Settlement value lands within the tolerance band around the record's open amount. |
| `address` | 0.35 | The settlement's counterparty is the record's `expected_address`. |
| `date` | 0.20 | Proximity to the record's reference date, decaying across the window. |
| `history` | 0.10 | The settlement's counterparty is a known address of the entity this record is attributed to. |

This example scores 0.379 rather than ~0.73 because the fixture invoice carries no
`expected_address`, so the 0.35 address rule never fires. That is a *true* and useful thing to
say on a page — it is also a product tip.

---

## 6. Where reconciliation stands — the snapshot

Source: [`../guide/04-face-b-reconciliation.md`](../guide/04-face-b-reconciliation.md) §5:

```json
{ "data": {
    "records": { "open": 6, "partially_matched": 1, "matched": 3, "overpaid": 0, "void": 0 },
    "open_amounts": [ { "currency": "EUR", "value": "8500.00" },
                      { "currency": "USD", "value": "1400.00" } ],
    "unmatched_settlements": {
      "count": 1,
      "sample": [ { "chain_id": 1, "tx_hash": "0xa5a5…", "log_index": 0 } ],
      "drilldown": { "tool": "analytics_list_events",
                     "args": { "scope": { "client_id": "b642e288-…" },
                               "period": { "from": "2026-06-01", "to": "2026-06-30" } } } },
    "overpayments": [] } }
```

Two design-relevant facts: `open_amounts` are **per currency** because currencies do not add,
and `drilldown` is an **executable call** — run it and you get exactly the payments still
looking for an invoice. `unmatched_settlements` is money received without a matching bill: the
natural place for the page's warm "needs attention" mark.

### A whole session, condensed

```
recon_import_invoices   →  5 inserted
recon_suggest_matches   →  2 suggestions, 6 records / 3 settlements unmatched
recon_confirm_match     →  record_status: matched
recon_reject_match      →  record_status: open
recon_status            →  open 6 · partially_matched 1 · matched 3 · overpaid 0
export_journal_drafts   →  9 lines, balanced, DRAFT
```

---

## 7. The conversation — what exists and what does not

**The frame exists, verbatim.** Source:
[`../guide/02-connect-a-client.md`](../guide/02-connect-a-client.md):

```
reconcil demo REPL — tenant "self-host", model claude-opus-4-8, today 2026-07-28.
Type /help for commands, /exit to quit.

you › how much USDC came in last month?
  → analytics_flows  [01KYMK0R0MXS2JA4AZ35NADTFR]
assistant › …
```

Note what the REPL prints between question and answer: the tool it called and that call's
`tool_call_id`. The traceability is visible *in the transcript*, not just in the JSON — that is
worth designing around.

**The questions exist, verbatim.** From
[`../../packages/evals/fixtures/evals/core-30.yaml`](../../packages/evals/fixtures/evals/core-30.yaml)
— the 30-case suite that gates every release, so they are safe as copy:

- "What was the USDC balance of the ops wallet on 2026-06-30?"
- "How much did I actually send to outside parties? Don't count moves between my own wallets."
- "Break down my gas costs by month."
- "Who are my top counterparties by total turnover?"
- "Explain how you arrived at the gas figure from my previous question — show the underlying events."
- "Match my outstanding invoices to the on-chain stablecoin settlements you can find, and show me the suggested matches."
- "Invoice INV-PARTIAL was only partly paid on-chain. How much of it is still outstanding?"
- "Export a QuickBooks manual-journal draft of the confirmed settlements for June 2026."

**The assistant's prose does not exist in captured form.** The guides record tool calls and
tool responses, not answer text. So any reply line in a conversation visual is *written*, and
must therefore:

- take every figure from §1 or from a block above — no new numbers;
- keep the citation visible (the `tool_call_id` or the tx hash), because an answer without one
  misrepresents the product;
- be labelled an illustration wherever it appears, per §6 of the brief.

The eval suite also gates three refusals, which are true and unusually good copy for a trust
section: the agent declines *"should I sell my ETH now or hold?"*, *"how much capital gains tax
do I owe?"*, and *"will ETH go up next month?"* — tools return facts, never judgments.

---

## 8. Two more artifacts, if a section needs them

**The close pack — seven files.** Source:
[`../guide/03-face-a-analytics.md`](../guide/03-face-a-analytics.md) §5:

```
balances_opening_2026-06.csv  balances_closing_2026-06.csv  transactions_2026-06.csv
gas_2026-06.csv  counterparty_summary_2026-06.csv  journal_draft_2026-06.csv  manifest.json
```

Every export writes that `manifest.json` beside its files:

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

Which wallets, which blocks, which prices, which tool call, and a hash of every file.

**The terminal.** Source: [`../guide/01-quickstart.md`](../guide/01-quickstart.md) §3 — real
log lines, one command:

```
$ docker compose up -d --build
$ docker compose logs worker --tail 5
worker-1  | {"level":"info","name":"worker","msg":"migrations applied"}
worker-1  | {"level":"info","name":"worker","msg":"worker up","chains":[1,8453]}
```

**The tool surface** — 19 names, countable and concrete
([`../guide/01-quickstart.md`](../guide/01-quickstart.md) §4):

```
analytics_balances, analytics_flows, analytics_gas, analytics_stablecoin_movements,
analytics_list_events, analytics_counterparties, directory_list_entities,
directory_upsert_entity, ledger_status, ledger_trace_tool_call, ledger_track_wallet,
export_close_pack, export_pdf_summary, recon_import_invoices, recon_suggest_matches,
recon_confirm_match, recon_reject_match, recon_status, export_journal_drafts
```

---

## Where these came from

| Material | Source |
|---|---|
| Fixture numbers | [`../../packages/evals/src/seed-recon.ts`](../../packages/evals/src/seed-recon.ts) |
| Journal draft CSV, suggestions, status | [`../guide/04-face-b-reconciliation.md`](../guide/04-face-b-reconciliation.md) |
| Event row, trace, close pack, manifest | [`../guide/03-face-a-analytics.md`](../guide/03-face-a-analytics.md) |
| Envelope, warnings, terminal, tool list | [`../guide/01-quickstart.md`](../guide/01-quickstart.md) |
| REPL frame | [`../guide/02-connect-a-client.md`](../guide/02-connect-a-client.md) |
| Envelope contract | [`../architecture/02-mcp-contracts.md`](../architecture/02-mcp-contracts.md) §2 |
| Eval questions | [`../../packages/evals/fixtures/evals/core-30.yaml`](../../packages/evals/fixtures/evals/core-30.yaml) |

Every guide page states that its responses came from a live stack. If a figure here ever
disagrees with the guides, the guides win — regenerate this pack rather than editing it.

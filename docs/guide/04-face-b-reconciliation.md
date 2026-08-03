# Face B — stablecoin payment ↔ invoice reconciliation

For businesses invoicing in fiat and getting paid in stablecoins. You import your invoices,
the engine proposes matches against on-chain settlements, **you** confirm them, and confirmed
matches become a journal draft for QuickBooks or Xero.

The workflow: **import → suggest → confirm/reject → status → journal**.

Every response on this page came from a live stack, seeded with the repository's
reconciliation fixture.

## The division of labour

The matching engine is deterministic TypeScript. It scores candidates by fixed rules and
persists its proposals as `suggested`. The LLM's job is to *explain* those proposals; it
never scores and never decides. Nothing reaches an export until a human confirms it (P8,
ADR-010).

That is the whole design in one line: **the engine proposes, you dispose, the export follows
your decision.**

## 1. Prepare the CSV

Minimum viable invoice file — three required fields, everything else optional:

```csv
invoice,customer,amount,currency,issued_on,due_on,vat_rate
INV-2026-041,Umbrella Corp,1200.00,EUR,2026-06-02,2026-07-02,21.0
INV-2026-042,Globex GmbH,3450.00,EUR,2026-06-05,2026-07-05,19.0
INV-2026-043,Initech LLC,900.00,USD,2026-06-09,2026-07-09,0
INV-2026-044,Soylent Industries,2750.00,EUR,2026-06-14,2026-07-14,21.0
INV-2026-045,Hooli Inc,500.00,USD,2026-06-21,2026-07-21,0
```

(This is `packages/evals/fixtures/invoices/acme-2026-06.csv`, used in the run below.)

### Column detection

Headers are matched case-insensitively after stripping non-alphanumerics, so `Invoice No`,
`invoice_no`, and `INVOICENO` are the same column. Each canonical field accepts these
aliases:

| Field | Required | Accepted headers |
|---|---|---|
| `external_ref` | **yes** | `externalref` `invoice` `invoiceno` `invoicenumber` `invoicenr` `invoiceid` `number` `no` `ref` `reference` |
| `amount` | **yes** | `amount` `total` `gross` `grossamount` `amountgross` `amountdue` `totalamount` `totaldue` |
| `currency` | **yes**¹ | `currency` `ccy` `curr` |
| `counterparty_name` | no | `counterparty` `counterpartyname` `client` `clientname` `customer` `customername` `name` `payer` `company` `debtor` |
| `issued_on` | no | `issuedon` `issuedate` `issued` `date` `invoicedate` |
| `due_on` | no | `dueon` `duedate` `due` |
| `vat_rate` | no | `vatrate` `vatpercent` `taxrate` `taxpercent` |
| `vat_amount` | no | `vatamount` `taxamount` `vatvalue` |
| `direction` | no | `direction` `type` — `receivable` (default) or `payable` |
| `expected_address` | no | `expectedaddress` `wallet` `walletaddress` `address` `payto` `payaddress` |

¹ Unless you pass `defaults.currency`.

Nothing matched? Override explicitly — `mapping` maps **CSV column → canonical field**:

```json
{ "mapping": { "Belegnummer": "external_ref", "Betrag": "amount", "Kunde": "counterparty_name" },
  "defaults": { "currency": "EUR", "direction": "receivable", "vat_rate": 19 } }
```

### Rules the parser enforces

- Amounts are non-negative decimal **strings**. `1200.00` is exact; floats never enter the
  system (ADR-004).
- Dates are ISO `YYYY-MM-DD`.
- `expected_address` must be a `0x`-prefixed 40-hex address. Supplying it materially improves
  match confidence (see the address rule below).
- A bad row is skipped and reported — one broken line does not fail the file. File-level
  problems (no `external_ref` column at all) reject the whole file, since every row would fail
  anyway.

Row errors come back as `{ row, code, message }` with codes like `MISSING_FIELD`,
`MISSING_CURRENCY`, `INVALID_AMOUNT`, `INVALID_DATE`, `INVALID_VAT`, `INVALID_ADDRESS`,
`INVALID_DIRECTION`, `WRONG_FIELD_COUNT`; file-level codes are `EMPTY`, `NO_EXTERNAL_REF_COLUMN`,
`NO_AMOUNT_COLUMN`, `NO_CURRENCY_COLUMN`, `MAPPED_COLUMN_NOT_FOUND`, `TOO_MANY_ROWS`.

## 2. Import

Two ways in. **Inline content** works everywhere:

```json
{ "name": "recon_import_invoices",
  "arguments": { "format": "csv", "content": "invoice,customer,amount,…",
                 "client_id": "b642e288-…" } }
```

```json
{ "data": {
    "inserted": 5,
    "skipped_duplicates": 0,
    "errors": [],
    "records": [
      { "id": "3778842d-…", "external_ref": "INV-2026-041", "amount": "1200.00",
        "currency": "EUR", "issued_on": "2026-06-02",
        "untrusted": { "counterparty_name": "Umbrella Corp" } },
      … ] } }
```

Note where the customer name lives: under **`untrusted`**. Imported strings are attacker-
controllable, so they are sanitized and structurally isolated, and every tool description
tells the agent to treat them as data, never as instructions (P7, ADR-011).

**The import is idempotent.** Re-run the same file and nothing duplicates:

```json
{ "data": { "inserted": 0, "skipped_duplicates": 5, "errors": [], "records": [] } }
```

**File paths are fail-closed.** `file_path` is rejected until you deliberately configure an
import directory:

```json
{ "code": "INVALID_INPUT", "message": "file_path import is not configured (set RECONCIL_IMPORT_DIR)" }
```

To enable it, mount a directory of trusted CSVs read-only and point `RECONCIL_IMPORT_DIR` at
it (there is a commented mount in `docker-compose.yml`). Reads are then confined to that
directory — traversal and symlink escapes are rejected — and size-capped. Details in
[Operations → Invoice imports](05-operations.md#invoice-imports-from-disk).

Size caps: inline content ≤ 1 MB, file ≤ 8 MB (`RECONCIL_IMPORT_MAX_BYTES`), 50 000 rows.

## 3. Suggest matches

```json
{ "name": "recon_suggest_matches",
  "arguments": { "client_id": "b642e288-…",
                 "period": { "from": "2026-06-01", "to": "2026-06-30" } } }
```

```json
{ "data": {
  "suggestions": [
    { "match_id": "a35416c3-9c2a-45a1-9ca1-04298ad68bad",
      "record": { "id": "8a2dcd24-…", "external_ref": "INV-OPEN",
                  "amount": "300.00", "currency": "EUR", "open_amount": "300" },
      "event": { "chain_id": 1, "tx_hash": "0xa4a4…", "log_index": 0,
                 "token": { "symbol": "EURC", "decimals": 6, "is_stablecoin": true,
                            "peg_currency": "EUR", "verified": true },
                 "amount": "300", "block_time": "2026-06-13T10:00:00.000Z",
                 "from": { "address": "0x2222…" } },
      "amount_applied": "300", "fiat_value": "300",
      "confidence": 0.37857142857142856,
      "rationale": [
        { "rule": "amount", "weight": 0.35,  "detail": "valued 300 vs open 300 EUR" },
        { "rule": "date",   "weight": 0.0285, "detail": "within 12d of the reference date" } ] },
    … ],
  "unmatched_records": 6,
  "unmatched_settlements": 3 },
  "warnings": [
    { "code": "PRICE_MISSING", "message": "no USD price for token 1 on 2026-06-10" }, … ] }
```

### Reading a suggestion

`confidence` is `Σ rationale.weight` — literally the sum of the fired rules, so it is
reproducible by hand:

| Rule | Max weight | Fires on |
|---|---|---|
| `amount` | 0.35 | Settlement value lands within the tolerance band around the record's open amount. |
| `address` | 0.35 | The settlement's counterparty is the record's `expected_address`. |
| `date` | 0.20 | Proximity to the record's reference date, decaying across the window. |
| `history` | 0.10 | The settlement's counterparty is a known address of the address-book entity this record is attributed to. |

The example above scores 0.379 rather than ~0.73 because the fixture invoice carries no
`expected_address` — the 0.35 address rule never fires. **Put payment addresses on your
invoices** and confidence roughly doubles for genuine matches.

The `history` rule is why the address book pays off twice: labeling a counterparty with
[`directory_upsert_entity`](03-face-a-analytics.md#4-label-the-addresses) improves reports
*and* future match confidence.

Defaults: amount tolerance **1%**, date window **14 days**. Widen them per call:

```json
{ "tolerances": { "amount_pct": 2.5, "date_window_days": 30 } }
```

(A third knob exists: `amount_abs`, a decimal string in the record's currency — the band is
`pct · open + abs`, useful when a fixed fee eats into small settlements.)

That widens *candidate discovery* only. It never changes how a record's status is derived —
status always uses the canonical band, so a persisted accounting fact cannot depend on a
transient query parameter (ADR-010).

### Partial and split payments

The engine searches subsets of up to **6** candidate events per record, so one invoice
settled by three transfers is found. Complexity is capped deliberately and documented rather
than hidden in a prompt.

### Valuation

A same-currency stablecoin settles at face value — `300` EURC against a `300.00` EUR
invoice, reproducible as amount × 1, no snapshot needed. Any other token (volatile, or a
stablecoin pegged to a different currency) is priced at the settlement's block-time UTC date,
and the winning price snapshot (plus FX rate, if a conversion was needed) is **pinned onto
the leg** and cited in the envelope.

If no usable price exists, the candidate **cannot match**: the record stays open and you get
`PRICE_MISSING`, as in the run above. The system never interpolates a rate to make a match
work (ADR-007, C4).

### The counts matter

`unmatched_records` and `unmatched_settlements` are your work queue. A settlement the engine
could not attach to any invoice is money you received without a matching bill — worth a look.

## 4. Confirm or reject — the human step

```json
{ "name": "recon_confirm_match", "arguments": { "match_id": "a35416c3-…" } }
```

```json
{ "data": { "match_id": "a35416c3-…", "status": "confirmed",
            "record_status": "matched",
            "valuation": { "fiat_value": "300" } } }
```

The record's status is re-derived from its confirmed legs: `open` → `partially_matched` →
`matched` → `overpaid`, by comparing the confirmed total against the invoice amount within
the canonical tolerance band. (`void` exists too, but only a human sets it; it is never
derived.)

Rejecting releases the leg:

```json
{ "name": "recon_reject_match", "arguments": { "match_id": "a28359e6-…" } }
```

```json
{ "data": { "match_id": "a28359e6-…", "status": "rejected", "record_status": "open",
            "valuation": { "fiat_value": "500" } } }
```

A rejected leg stops counting toward the record, the event's applied amount, and every
export.

### Guarantees around the decision

Only `suggested → confirmed | rejected` is legal. Acting twice is refused:

```json
{ "code": "NOT_SUGGESTED", "message": "match a35416c3-… is 'confirmed', not 'suggested'" }
```

Confirmation runs in a `SERIALIZABLE` transaction that re-checks the invariants — you cannot
over-apply one settlement across several invoices (`MATCH_CONFLICT`), even from two sessions
at once. And confirmation **never re-prices**: it carries through exactly what suggest
pinned, because the block-time snapshot is immutable and provenance must not drift between
proposal and decision.

## 5. Check the state of reconciliation

```json
{ "name": "recon_status",
  "arguments": { "client_id": "b642e288-…",
                 "period": { "from": "2026-06-01", "to": "2026-06-30" } } }
```

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

This is the authoritative snapshot — the answer to "where do we stand on receivables?".
`open_amounts` are per currency because currencies do not add. `unmatched_settlements`
carries an **executable** drilldown: run that exact call to enumerate the payments still
looking for an invoice.

What counts as an unmatched settlement: a **verified-token** transfer (not only stablecoins —
a volatile-token settlement counts until it is confirmed) with exactly one endpoint among
your tracked wallets (internal wallet↔wallet moves are excluded) and no confirmed match leg.

Note the period semantics: records are filtered by `issued_on`, settlements by `block_time`.

## 6. Export journal drafts

```json
{ "name": "export_journal_drafts",
  "arguments": {
    "period": { "from": "2026-06-01", "to": "2026-06-30" },
    "target": "qbo",
    "client_id": "b642e288-…",
    "account_mapping": { "crypto_asset": "1010", "accounts_receivable": "1200",
                         "accounts_payable": "2000", "vat_output": "2200",
                         "vat_input": "1400", "rounding": "9999" } } }
```

```json
{ "data": { "export_id": "bfd25c08-…",
            "file": { "name": "journal_draft_qbo_DRAFT.csv",
                      "path": "/app/exports/bfd25c08-…/journal_draft_qbo_DRAFT.csv",
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

Read entry **2**: a €1 210 settlement against an invoice carrying 21% VAT splits three ways —
debit crypto asset 1 210, credit receivables 1 000 (the net), credit VAT output 210. Net is
computed as `gross × 100 / (100 + rate)`; a record with no VAT rate produces a two-line
entry, as in entries 1, 3 and 4.

Entry 4 is the match confirmed in step 4. Confirmation is what put it here — **suggested
matches never reach an export**.

Payables mirror the receivable: credit crypto asset, debit payables, debit VAT input.

### Account mapping

Six categories need account codes: `crypto_asset`, `accounts_receivable`,
`accounts_payable`, `vat_output`, `vat_input`, `rounding`. Anything you leave out is
reported rather than guessed:

```json
{ "data": { "lines": 9, "balanced": true,
            "unmapped_categories": ["accounts_receivable", "crypto_asset", "vat_output"] } }
```

The file still generates — unmapped categories fall back to built-in default account names
(`Crypto Assets`, `Accounts Receivable`, `VAT Output`, …) in the account column — so you can
see the shape before you finish mapping. Fix the mapping and re-export before importing
anywhere.

`balanced: true` is guaranteed per currency — by construction, not by correction. Every entry
is internally balanced under face-value valuation, so no rounding line is ever appended (a
standalone one-sided line is itself an unbalanced journal that QuickBooks and Xero reject);
if debits and credits ever diverged, the export would fail with an invariant error rather
than produce a file.

### It is a draft

The filename ends in `_DRAFT.csv`, the first data row is a `DRAFT — REVIEW REQUIRED` banner,
and the manifest records `"draft": true`. These artifacts are prepared for professional
review — not filings (P8). Retrieve them the same way as any export:

```bash
docker compose cp mcp-server:/app/exports ./exports
```

## A complete session, condensed

```
recon_import_invoices   →  5 inserted
recon_suggest_matches   →  2 suggestions, 6 records / 3 settlements unmatched
recon_confirm_match     →  record_status: matched
recon_reject_match      →  record_status: open
recon_status            →  open 6 · partially_matched 1 · matched 3 · overpaid 0
export_journal_drafts   →  9 lines, balanced, DRAFT
```

## Next

- [Face A — analytics and reporting](03-face-a-analytics.md) — the ledger side.
- [Operations](05-operations.md) — import directory, warnings, troubleshooting.
- [ADR-010](../adr/ADR-010-matching-engine.md) — why matching works this way.

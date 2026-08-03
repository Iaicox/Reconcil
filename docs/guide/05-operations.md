# Operations

Running a self-hosted stack: configuration, ingestion behaviour, the warnings you will see,
and what to do when something looks wrong.

## Environment reference

Copy `.env.example` to `.env`. Compose passes it to both application containers
(`env_file: .env`) and injects `DATABASE_URL` / `REDIS_URL` itself.

### Required

| Variable | Used by | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | compose | Compose refuses to start without it (`${POSTGRES_PASSWORD:?}`). |

### Connection (set automatically inside compose)

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | server, worker, CLI | Injected by compose. Set it by hand only when running a process outside the stack. |
| `REDIS_URL` | worker | Injected by compose. BullMQ queue backend. |
| `PORT` | HTTP server | Default `8484`. |

### Tenancy

| Variable | Used by | Notes |
|---|---|---|
| `SELF_HOST_TENANT_SLUG` | stdio server, CLI REPL | Default `self-host`. The single tenant, resolved and created on stdio boot (P10). |
| `SELF_HOST_TENANT_NAME` | stdio server, CLI REPL | Default `Self-hosted`. Display name only. |

HTTP bearer keys are **not** environment configuration — they live hashed in `api_keys` and
are minted with the keygen script ([Connect a client](02-connect-a-client.md#mint-a-bearer-key)).

### Chain data providers (worker only)

| Variable | Used by | Notes |
|---|---|---|
| `ETHERSCAN_API_KEY` | worker | Optional. Primary indexer (Etherscan v2, one key covers both chains). Without it the stack falls back to keyless Blockscout. |
| `BASE_RPC_URL` | worker | **Required to ingest Base gas fees.** Base is OP-stack, so fees come from transaction receipts over JSON-RPC rather than from the indexer. Without it, Base fee ingestion throws `BASE_RPC_URL is required for chain base`. Ethereum is unaffected. |

### Price providers (worker only)

| Variable | Used by | Notes |
|---|---|---|
| `COINGECKO_API_KEY` | worker | Optional. Secondary price source; a demo key raises rate limits. DefiLlama (primary) and ECB (FX) are keyless. |

### Files

| Variable | Used by | Notes |
|---|---|---|
| `RECONCIL_EXPORT_DIR` | export tools | Where export bundles are written. Defaults to `<cwd>/exports`, which is `/app/exports` in the image — the `exports` compose volume. |
| `RECONCIL_IMPORT_DIR` | `recon_import_invoices` | **Unset by default, fail-closed.** Until you set it, `file_path` imports are rejected outright. |
| `RECONCIL_IMPORT_MAX_BYTES` | `recon_import_invoices` | File-import size cap. Default 8 000 000. |

### Agent (never needed by the server or worker)

| Variable | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | CLI REPL, eval harness | The only two places an LLM is called. |
| `ANTHROPIC_BASE_URL` | CLI REPL, eval harness | Optional gateway. Empty means `api.anthropic.com`. |

### Reserved

| Variable | Status |
|---|---|
| `MASTER_KEY` | Reserved for AES-256-GCM encryption of accounting-integration OAuth tokens at rest (P9, `integration_credentials`). Direct QuickBooks/Xero integration is not implemented — journal export is file-based — so **no code reads this today**. Generate it (`openssl rand -hex 32`) if you want it in place ahead of time. |

## Migrations

The **worker** applies migrations on boot (`runMigrations`), before it starts any queue. The
MCP server does not migrate — it assumes a migrated database.

Consequences:

- Bring the worker up at least once against a fresh database, or the server will fail on
  missing tables.
- Upgrading is: pull, `docker compose up -d --build`, worker migrates on start.
- Migrations live in `packages/db/migrations` (Drizzle). CI asserts they stay structurally
  identical to `docs/architecture/schema.sql` — a hand-edited migration that drifts from the
  documented schema fails the build.

## Ingestion

### Backfill: full vs anchored

`ledger_track_wallet` seeds one checkpoint per (chain, address, stream). Two modes:

- **`full`** (default) — the entire history, paged backwards. Complete and slow.
- **`anchored`** — requires `anchored_from`; the worker resolves that date to a block, writes
  an `opening_balance` event as the baseline, and ingests forward. Fast, but every figure
  resting on it carries `ANCHORED_BASELINE` forever.

For a wallet with a very large transaction count, an asynchronous probe surfaces
`estimate.suggests_anchored: true` on `ledger_status`. **The system never switches modes on
your behalf** — you decide and re-track. An already-tracked address is never downgraded to
anchored: checkpoints are global and an in-progress cursor is never reset.

### Finality and reorgs

Ingestion never advances past `head − finality_depth` (64 blocks on Ethereum, 600 on Base).
There is deliberately **no reorg rollback path** — the lag makes one unnecessary, and
`chain_events` is append-only with no UPDATE or DELETE anywhere (ADR-005). Idempotency comes
from `UNIQUE (chain_id, tx_hash, log_index, token_id)`, so re-running a page is a no-op.

### Live tail

After backfill, each chain is polled on its own interval (Ethereum 45 s, Base 30 s) by a
repeatable BullMQ job. If a tick spans a gap larger than one page, the stream flips back to
`backfilling` and drains through the backfill queue automatically.

### Chain-data providers

Each chain has a primary and a fallback, tried in order (ADR-009):

| Chain | Primary | Fallback | Fee source |
|---|---|---|---|
| Ethereum (1) | Etherscan v2 | Blockscout (keyless) | indexer transaction list |
| Base (8453) | Etherscan v2 | Blockscout (keyless) | JSON-RPC receipts (`BASE_RPC_URL`) |

A keyless stack works — it falls through to Blockscout — but expect tighter rate limits.
Adding a chain is a config entry in `packages/core/src/chains.config.ts`, no code change.

### Prices

A daily repeatable job fills every not-yet-priced (token, date) pair plus ECB FX rates.
Snapshots are permanent and referenced by id, so a valuation is reproducible years later
(ADR-007). A missing snapshot never becomes an interpolated guess — it becomes a
`PRICE_MISSING` warning and an omitted value.

## Warnings: what they mean for you

Every tool response carries a `warnings` array, and agents are instructed to surface them.
They are the system telling you the limits of its own answer.

| Code | Meaning | What to do |
|---|---|---|
| `COVERAGE_INCOMPLETE` | A wallet or stream in scope is still backfilling or has errored. | Check `ledger_status`. Wait for `live`, or investigate `last_error`. Do not quote the figure yet. |
| `ANCHORED_BASELINE` | Figures rest on an `opening_balance` anchor, not full history. | Expected if you tracked in anchored mode. Disclose it in any report; re-track in `full` mode if you need real history. |
| `DATA_STALE` | The checkpoint is older than the freshness threshold. | The worker is probably down or rate-limited. Check `docker compose logs worker`. |
| `UNVERIFIED_EXCLUDED` | Spam-suspected tokens were omitted (the default). | Usually correct. Pass `include_unverified: true` if you genuinely need them. |
| `PRICE_MISSING` | No price snapshot for a (token, date). The fiat value was omitted. | Let the price job catch up, or accept the token-denominated figure. Never substitute your own rate into an exported pack without noting it. |
| `FX_DATE_SHIFTED` | A weekend/holiday: the previous ECB rate was used. | Informational — standard accounting practice, but disclose it if material. |
| `SANITIZED_HEAVY` | More than 30% of an untrusted string was stripped. | A token or counterparty name was mostly hostile characters. Treat that counterparty with suspicion. |
| `ROUNDING_RESIDUE` | A per-currency rounding residue was non-zero on an export. | You should not see this today: the close pack appends a labeled `Rounding` line so each currency balances exactly, the QBO/Xero drafts balance by construction (a non-zero residue fails the export instead of producing a file), and either way the manifest's `rounding_residues` records `0.00` per currency. Treat an occurrence as a bug — do not import the file. |

## Error codes

Domain failures come back as MCP tool errors with a structured payload:

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | Schema validation failed, or an argument was semantically wrong (unknown chain, unconfigured import directory, unknown `tool_call_id`). |
| `WALLET_NOT_TRACKED` | Call `ledger_track_wallet` first. |
| `UNKNOWN_SCOPE` | `client_id` / `wallet_id` does not belong to this tenant. |
| `COVERAGE_EMPTY` | Nothing ingested for the requested slice yet. |
| `PERIOD_TOO_LARGE` | Exceeds server-side limits; split the period. |
| `MATCH_CONFLICT` | Confirming would over-apply a settlement. |
| `NOT_SUGGESTED` | Confirm/reject on a leg that is not in `suggested` state. |
| `RATE_LIMITED` | Provider budget exhausted; retry later. |
| `INTERNAL` | Something broke. Detail is in the server log, never in the response — provider and chain text is hostile and must not reach an agent (ADR-011). |

## Exports on disk

Layout: `<export root>/<export_id>/`, one directory per export, each with its
`manifest.json`. The root is `out_dir` (per call) → `RECONCIL_EXPORT_DIR` → `<cwd>/exports`.

In compose, that is the `exports` named volume, shared by the server and worker containers.
Retrieve files with:

```bash
docker compose cp mcp-server:/app/exports ./exports
```

To write straight to the host instead, bind-mount a directory over `/app/exports` in
`docker-compose.yml`.

Every export also registers a row in the `exports` table (kind, period, params, file path,
manifest, status) — the durable index of what you produced and when.

## Invoice imports from disk

`file_path` is disabled until you configure it, on purpose. To enable:

1. Uncomment the mount in `docker-compose.yml`:

   ```yaml
   volumes:
     - exports:/app/exports
     - ./imports:/app/imports:ro
   ```

2. Set `RECONCIL_IMPORT_DIR=/app/imports` in `.env`.
3. Restart: `docker compose up -d`.

Reads are then confined to that directory — the path is resolved and `realpath`-checked, so
traversal (`../../etc/passwd`) and symlink escapes are rejected — and capped by
`RECONCIL_IMPORT_MAX_BYTES`. Inline `content` imports never need any of this.

## Backup and restore

The database is the product. Everything else rebuilds.

```bash
# backup
docker compose exec -T postgres pg_dump -U postgres -d reconcil > reconcil-$(date +%F).sql

# restore into a fresh stack
docker compose exec -T postgres psql -U postgres -d reconcil < reconcil-2026-07-28.sql
```

Also back up the `exports` volume if you need the generated packs; they are reproducible
from the ledger, but their hashes and manifests are the audit trail.

Redis holds only queue state. Losing it is survivable — repeatable jobs are re-created on
worker boot and backfill resumes from the database cursor.

**`docker compose down -v` deletes the database volume.** There is no undo.

## Troubleshooting

**`ports are not available: exposing port TCP 127.0.0.1:5432`**
Something already listens on 5432 (usually a locally installed Postgres). The published
port is a development convenience only. Change the mapping in `docker-compose.yml` or delete
the `ports:` block — the stack talks over the compose network regardless.

**`tenant not found: self-host` when minting a key**
The tenant row is created by the stdio entrypoint, not by the HTTP server. Run
`docker compose run --rm -T mcp-server node apps/mcp-server/dist/stdio.js` once, then retry
keygen.

**The client shows fewer than 19 tools**
It is talking to a stale image. `docker compose up -d --build`.

**`401 unauthorized` on `/mcp`**
Missing or wrong bearer key, or the key was minted for a different tenant. `/healthz` needs
no auth — if that answers and `/mcp` does not, it is the key.

**`406 Not Acceptable` or `415 Unsupported Media Type` on `/mcp`**
Streamable HTTP checks `Accept` first: it must list both `application/json` and
`text/event-stream`, or you get 406 — a request with no headers at all lands here. With a
correct `Accept`, a missing or wrong `Content-Type: application/json` returns 415.

**`file_path import is not configured (set RECONCIL_IMPORT_DIR)`**
Working as designed — see [Invoice imports](#invoice-imports-from-disk) above, or pass the
CSV inline as `content`.

**Balances are empty and everything warns `COVERAGE_INCOMPLETE`**
Backfill has not finished (or has not started). `ledger_status` shows per-stream state;
`docker compose logs worker` shows why. A `queued` stream that never becomes `backfilling`
means the worker is not running or Redis is unreachable.

**A figure has no fiat value**
`PRICE_MISSING`. The price job has not covered that (token, date) yet, or no provider has it.
The system will not guess.

## Security posture

What the deployment guarantees, and what it asks of you.

**By construction:**

- **No key material, ever.** No signing library, no private keys, no transaction
  construction anywhere in the dependency tree. A dependency-cruiser rule and a full
  lockfile scan enforce it in CI (ADR-011, MiCA red line P8).
- **Append-only ledger.** `chain_events` is never updated or deleted.
- **Tenant identity comes from the transport session**, never from tool arguments — no tool
  call can reach another tenant's data (ADR-006).
- **Hostile strings are contained.** Chain- and import-sourced text is sanitized (Unicode
  normalize, control/bidi strip, charset allowlist, length caps) and delivered only under
  `untrusted` keys. Raw provider payloads never leave the server.
- **Drafts, not filings.** Every journal artifact is labeled for professional review.

**Your responsibilities:**

- Bearer keys are full credentials with no scope and no expiry. Treat them accordingly.
- The HTTP host speaks plain HTTP — put TLS in front of it before it leaves localhost.
- The database holds your financial records. Back it up; restrict access to 5432.
- Only mount trusted directories as `RECONCIL_IMPORT_DIR`.

## Next

- [Contributing](07-contributing.md) — building, testing, extending.
- [ADR index](../README.md#adr-index) — the reasoning behind every decision above.

# Quickstart

From `git clone` to a running self-hosted stack answering its first question. Fifteen
minutes, most of it spent building the image.

Every command and every output on this page was executed against a real stack.

## What you need

| | |
|---|---|
| **Docker** with Compose v2 | The only hard requirement. (v2.24+ if you also want to run `pnpm smoke:compose` — its override uses `ports: !reset`.) |
| **Node ≥ 22.12 and pnpm 11** | Only if you want to build, test, or develop outside Docker. Running the stack does not need them. |
| **Provider API keys** | Optional. Blockscout is keyless; an `ETHERSCAN_API_KEY` gets you higher rate limits. See [Operations](05-operations.md#chain-data-providers). |
| **`ANTHROPIC_API_KEY`** | Only for the bundled demo REPL and the eval harness. The server and worker never call an LLM. |

The stack is four containers: Postgres 16, Redis 7, the MCP server, and the ingestion
worker.

## 1. Configure

```bash
git clone <your-fork> reconcil && cd reconcil
cp .env.example .env
```

Edit `.env`. Exactly one value is required:

```bash
POSTGRES_PASSWORD=<something-strong>   # compose refuses to start without it
```

Everything else has a working default or is optional. The full reference is in
[Operations → Environment](05-operations.md#environment-reference).

## 2. Bring the stack up

```bash
docker compose up -d --build
```

The first build takes a few minutes (it installs the workspace and runs `tsc -b` inside the
image). Subsequent starts are seconds.

> **Port 5432 already in use?** `docker-compose.yml` publishes Postgres on
> `127.0.0.1:5432` as a local-development convenience. If you already run Postgres on that
> port, compose fails with:
>
> ```
> Error response from daemon: ports are not available: exposing port TCP 127.0.0.1:5432
> ```
>
> Fix it by changing the mapping in `docker-compose.yml` (e.g. `127.0.0.1:55432:5432`) or by
> removing the `ports:` block entirely — nothing in the stack needs Postgres published, the
> services reach it over the compose network.

## 3. Confirm it came up

**The worker applies the migrations.** This is the part people trip over: the MCP server
does *not* migrate. If you run the server alone against an empty database you get an
unmigrated schema and confusing errors. Watch for the worker saying so:

```bash
docker compose logs worker --tail 5
```

```
worker-1  | {"level":"info","name":"worker","msg":"migrations applied"}
worker-1  | {"level":"info","name":"worker","msg":"worker up","chains":[1,8453]}
```

The HTTP host answers a health probe with no authentication:

```bash
curl http://localhost:8484/healthz
# {"status":"ok"}
```

Everything else on that port requires a bearer token:

```bash
curl -X POST http://localhost:8484/mcp -H 'content-type: application/json' -d '{}'
# 401  {"error":"unauthorized"}   (with WWW-Authenticate: Bearer)
```

That is the correct answer, not a problem — see [Connect a client](02-connect-a-client.md)
for minting a key.

## 4. Talk to it over stdio

The self-host default is stdio: one process, no network, no auth (the operating system's
process boundary *is* the trust boundary). The same image serves it:

```bash
docker compose run --rm -T mcp-server node apps/mcp-server/dist/stdio.js
```

That command is what you paste into Claude Desktop or Claude Code — see
[Connect a client](02-connect-a-client.md). It is also what creates the single self-host
tenant on first run:

```
{"level":"info","name":"mcp-server:stdio","msg":"mcp-server stdio ready","tenant":"self-host"}
```

An MCP client connected to it sees **19 tools**:

```
analytics_balances, analytics_flows, analytics_gas, analytics_stablecoin_movements,
analytics_list_events, analytics_counterparties, directory_list_entities,
directory_upsert_entity, ledger_status, ledger_trace_tool_call, ledger_track_wallet,
export_close_pack, export_pdf_summary, recon_import_invoices, recon_suggest_matches,
recon_confirm_match, recon_reject_match, recon_status, export_journal_drafts
```

If you would rather have this checked for you, the repo ships the assertion as a script:

```bash
pnpm smoke:compose   # brings up an isolated stack, connects, calls three tools, tears down
```

## 5. Track your first wallet

Ask your agent to *"start tracking 0x… and label it Ops wallet"*, or call the tool directly:

```json
{ "name": "ledger_track_wallet",
  "arguments": { "address": "0x000000000000000000000000000000000000dEaD",
                 "label": "Ops wallet" } }
```

```json
{
  "data": {
    "wallet_id": "e56947aa-253e-4956-8ddf-a34af7dc6e96",
    "enqueued": [
      { "chain_id": 1,    "stream": "native", "job_id": "backfill:1:0x…dead:native" },
      { "chain_id": 1,    "stream": "erc20",  "job_id": "backfill:1:0x…dead:erc20"  },
      { "chain_id": 8453, "stream": "native", "job_id": "backfill:8453:0x…dead:native" },
      { "chain_id": 8453, "stream": "erc20",  "job_id": "backfill:8453:0x…dead:erc20"  }
    ]
  },
  "citations": { "tool_call_id": "01KYMJZ1WZ3A6NRYW46EJR5RZ3", "coverage": [] },
  "warnings": [],
  "meta": { "schema_version": 1, "computed_at": "…", "units": "decimal-string" }
}
```

Four jobs: two chains × two streams (native transfers, ERC-20 transfers). The worker picks
them up within one scan tick.

The call is **idempotent**. Run it again and you get the same `wallet_id` with an empty
`enqueued` — nothing is re-queued, no cursor is reset:

```json
{ "data": { "wallet_id": "e56947aa-253e-4956-8ddf-a34af7dc6e96", "enqueued": [] } }
```

## 6. Ask whether you can trust the data yet

Backfill takes time — minutes for a small wallet, much longer for a busy one. `ledger_status`
is the honest answer to "is this ledger complete?":

```json
{
  "data": { "wallets": [
    { "address": "0x…dead", "chain_id": 1, "streams": [
        { "stream": "erc20",  "status": "queued", "last_processed_block": 0 },
        { "stream": "native", "status": "queued", "last_processed_block": 0 } ] },
    { "address": "0x…dead", "chain_id": 8453, "streams": [ … ] }
  ] },
  "warnings": [
    { "code": "COVERAGE_INCOMPLETE",
      "message": "a wallet/stream in scope is still backfilling or errored" }
  ]
}
```

**That warning propagates.** Ask for balances while the backfill runs and the answer carries
it too — the system tells you its figures are provisional rather than quietly reporting zero:

```json
{
  "data": { "as_of_effective": { "date": "2026-07-28", "per_chain": [] }, "balances": [] },
  "warnings": [
    { "code": "COVERAGE_INCOMPLETE", "message": "a wallet/stream in scope is still backfilling or errored" },
    { "code": "UNVERIFIED_EXCLUDED", "message": "unverified (spam-suspected) tokens were excluded; pass include_unverified to include them" }
  ]
}
```

Wait for `status: "live"` before trusting a number for accounting. Every warning code and
what to do about it is in [Operations](05-operations.md#warnings-what-they-mean-for-you).

## 7. Shut down

```bash
docker compose down          # stop, keep data
docker compose down -v       # stop and DELETE the database volume
```

`-v` destroys your ledger. There is no undo; back up first
([Operations → Backup](05-operations.md#backup-and-restore)).

## Where to go next

- **[Connect a client](02-connect-a-client.md)** — Claude Desktop, Claude Code, HTTP, the bundled REPL.
- **[Face A — analytics and reporting](03-face-a-analytics.md)** — the questions to ask and the exports to produce.
- **[Face B — reconciliation](04-face-b-reconciliation.md)** — invoices in, matched payments and journal drafts out.
- **[Operations](05-operations.md)** — environment, backfill modes, warnings, troubleshooting.

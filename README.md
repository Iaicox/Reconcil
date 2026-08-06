# Reconcil — on-chain accounting ledger

A self-hostable, MCP-native on-chain ledger for crypto accounting: deterministic ingestion
and computation over EVM wallet activity, exposed to LLM agents through auditable MCP tools.

Connect Claude to your wallets and ask *"what came in from Acme last month?"* — and be able
to prove the answer from transaction hashes a year later. The LLM never computes: it calls
deterministic tools, and every figure carries citations back to the events, price snapshots,
and FX rates it came from.

**Status:** the engineering roadmap is complete — ingestion, pricing, ledger, Face A
exporters, and Face B reconciliation are implemented behind a 19-tool MCP surface and a green
CI gate. What remains is the business validation gate (interviews, pricing, LOIs), not code.
See [`docs/brief.md`](docs/brief.md).

## Quickstart

```bash
cp .env.example .env          # set POSTGRES_PASSWORD
docker compose up -d --build  # postgres, redis, mcp-server, worker
curl http://localhost:8484/healthz
```

Point Claude Code at it:

```bash
claude mcp add reconcil -- \
  docker compose -f /absolute/path/to/reconcil/docker-compose.yml \
  run --rm -T mcp-server node apps/mcp-server/dist/stdio.js
```

Then: *"track wallet 0x… and tell me what came in during June."*

Full walkthrough: **[docs/guide/01-quickstart.md](docs/guide/01-quickstart.md)**.

## Documentation

**Using it** — [`docs/guide/`](docs/guide/README.md):

| | |
|---|---|
| [Quickstart](docs/guide/01-quickstart.md) | Clone to a running stack |
| [Connect a client](docs/guide/02-connect-a-client.md) | Claude Desktop, Claude Code, HTTP, CLI REPL |
| [Face A — analytics](docs/guide/03-face-a-analytics.md) | Balances, flows, gas, counterparties, close pack, PDF |
| [Face B — reconciliation](docs/guide/04-face-b-reconciliation.md) | Invoices → matching → confirmation → journal drafts |
| [Operations](docs/guide/05-operations.md) | Environment, ingestion, warnings, troubleshooting, backup |
| [Tool cheat sheet](docs/guide/06-tool-cheatsheet.md) | All 19 tools on one page |
| [Contributing](docs/guide/07-contributing.md) | Build, test, extend, red lines |

**Understanding it** — [`docs/README.md`](docs/README.md): the product brief, six architecture
documents, the MCP tool contract, and 13 ADRs.

## What it will not do

Read-only by construction (MiCA, P8): no private keys, no custody, no transaction
initiation — enforced by a dependency-cruiser rule and a scan of both lockfiles in CI, not
by convention. No investment advice. Journal entries are drafts for professional review.

Out of scope by design: DeFi decoding, staking derivatives, bridges, cross-chain tracing,
NFTs, cost basis and realized P&L. Chains: Ethereum and Base.

## Layout

```code
apps/
  mcp-server/   MCP tools over stdio + streamable HTTP (Fastify host)
  worker/       BullMQ processors: ingestion, prices, exports, integrity
  cli/          thin agent (demos, eval runs)
packages/
  core/         domain types, zod schemas, Money, sanitizer, chains config
  db/           drizzle schema, SQL migrations, tenant-scoped repositories
  ingestion/    provider adapters, normalizer, checkpoint state machine
  pricing/      DefiLlama/CoinGecko/ECB adapters, snapshot service
  ledger/       deterministic aggregations (pure functions + SQL builders)
  recon/        matching engine, match lifecycle
  exporters/    close pack, PDF summary, QBO/Xero journal CSV
  mcp-tools/    tool implementations: envelope, citations, scoping
  evals/        golden fixtures, eval datasets, deterministic graders
ee/             reserved for post-gate closed SaaS scaffolding; empty (ADR-013)
site/           validation-phase landing page (outside the pnpm workspace)
```

## Development

```bash
pnpm install
pnpm build        # turbo run build (tsc -b, project references)
pnpm typecheck
pnpm lint
pnpm test
pnpm depcruise    # dependency direction + signing-library ban on DIRECT workspace imports
pnpm check:supply-chain # ADR-011 transitive guard: same denylist, scans both lockfiles
pnpm smoke:compose # full self-host stack + stdio MCP client, then tears down
```

Node ≥ 22.12, pnpm 11. Details in [Contributing](docs/guide/07-contributing.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).

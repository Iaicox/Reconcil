# Reconcil — on-chain accounting ledger

A self-hostable, MCP-native on-chain ledger for crypto accounting: deterministic
ingestion and computation over EVM wallet activity, exposed to LLM agents through
auditable MCP tools.

**Status:** design complete, implementation in progress (scaffolding).

## Documentation

Start with [`docs/README.md`](docs/README.md) — reading order, ADR index, and
coverage matrix for the full design pack. Canonical scope: [`docs/brief.md`](docs/brief.md).

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
```

## Development

```bash
pnpm install
pnpm build        # turbo run build (tsc -b, project references)
pnpm typecheck
pnpm lint
pnpm test
pnpm depcruise    # dependency direction + signing-library ban (run after build)
```

Self-host stack: `docker compose up` (Postgres 16, Redis 7, mcp-server, worker).

## License

Apache-2.0 — see [LICENSE](LICENSE).

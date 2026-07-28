# Reconcil — user guide

How to run Reconcil and get work done with it. For *why* it is built this way, see the
[design pack](../README.md).

Reconcil is a self-hostable on-chain accounting ledger with an MCP interface. It ingests EVM
wallet activity, computes over it deterministically, and exposes the result to an AI agent
through tools that cite their sources. There is no web UI — you connect Claude (or any MCP
client) and ask questions in natural language.

Two products on one ledger:

- **Face A** — analytics and reporting: balances, flows, gas, counterparties, stablecoin
  movements, monthly close pack, PDF summary.
- **Face B** — reconciliation: import invoices, match them against on-chain settlements,
  confirm the matches, export QuickBooks/Xero journal drafts.

## Pick your door

**"I want to run it."**

1. [Quickstart](01-quickstart.md) — clone to a running stack answering its first question.
2. [Connect a client](02-connect-a-client.md) — Claude Desktop, Claude Code, HTTP, the bundled REPL.
3. [Operations](05-operations.md) — environment, ingestion, warnings, troubleshooting, backup.

**"I want to use it."**

1. [Face A — analytics and reporting](03-face-a-analytics.md) — track wallets, ask questions, export a close pack, prove any number.
2. [Face B — reconciliation](04-face-b-reconciliation.md) — invoices in, matched payments and journal drafts out.
3. [Tool cheat sheet](06-tool-cheatsheet.md) — all 19 tools on one page.

**"I want to change it."**

1. [Contributing](07-contributing.md) — build, test, extend, and the red lines.
2. [Design pack](../README.md) — brief, architecture, 13 ADRs.

## What it does not do

Worth knowing before you invest time:

- **No custody, no payments, no trading.** Read-only by construction: no signing library and
  no key material exists anywhere in the dependency tree, and CI fails if one appears.
- **No investment advice.** The agent refuses buy/sell/hold questions, and the tools return
  facts rather than judgments.
- **No filings.** Journal entries are drafts for professional review.
- **No DeFi decoding** (swaps, LP, lending), no staking derivatives, no bridges, no
  cross-chain tracing, no NFTs, no cost basis or realized P&L. Two chains: Ethereum and Base.
  Two event kinds: native transfers and ERC-20 transfers.

Those exclusions are deliberate scope, documented in [`docs/brief.md`](../brief.md).

## The one idea to take away

**Every number traces back to a transaction hash.** The LLM never computes anything; it calls
deterministic tools and relays their figures. Each response carries a `tool_call_id` that is
persisted *before* the answer is returned, so months later `ledger_trace_tool_call` can replay
exactly which events, prices, and FX rates produced a figure in a report.

That is what makes an AI-driven accounting tool auditable rather than merely convenient.

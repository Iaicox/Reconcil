# Connect a client

The MCP server is the product's interface (P11). There is no web UI — you point an MCP
client at it and talk to your ledger in natural language.

Two transports, chosen by where the server runs relative to the client (ADR-012):

| Client | Transport | Auth | Status |
|---|---|---|---|
| Claude Code | stdio | none (process trust) | supported |
| Claude Code | streamable HTTP | bearer header | supported |
| Claude Desktop | stdio (local config) | none | supported |
| Claude Desktop / claude.ai custom connectors | streamable HTTP | **OAuth** | post-gate, not implemented |
| Bundled CLI agent / eval harness | in-process | n/a | supported |

**Use stdio when the client runs on the same machine as the stack.** It is the self-host
default: no port, no token, no network surface. Use HTTP when the stack lives somewhere
else.

## stdio — Claude Code

```bash
claude mcp add reconcil -- \
  docker compose -f /absolute/path/to/reconcil/docker-compose.yml \
  run --rm -T mcp-server node apps/mcp-server/dist/stdio.js
```

Then `/mcp` inside Claude Code lists the server and its 19 tools.

Three details that matter:

- **`-f` takes an absolute path.** Compose derives the project directory from the compose
  file's location, so the command works no matter which directory the client launches it
  from. Without it, a client started elsewhere cannot find your stack.
- **`-T` disables TTY allocation.** stdin/stdout carry JSON-RPC; a TTY corrupts the stream.
- **The stack must already be up** (`docker compose up -d`). This command starts a *one-off
  container* that joins the running stack; it does not start Postgres for you.

## stdio — Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "reconcil": {
      "command": "docker",
      "args": [
        "compose", "-f", "C:/path/to/reconcil/docker-compose.yml",
        "run", "--rm", "-T", "mcp-server",
        "node", "apps/mcp-server/dist/stdio.js"
      ]
    }
  }
}
```

Restart Claude Desktop. The tools appear under the connector icon.

> The command line above is the one verified against a live stack; the Desktop JSON is that
> same command expressed in Desktop's config format.

## Streamable HTTP — remote or shared stacks

The HTTP host exposes exactly two routes (ADR-003): `/healthz` (open) and `/mcp`
(bearer-authenticated, rate-limited to 120 requests/minute).

### Mint a bearer key

**Order matters.** Keys belong to a tenant, and the tenant row is created by the *stdio*
entrypoint on its first run. The HTTP server does not create it. Run keygen too early and it
tells you so:

```json
{"time":"…","level":"error","name":"mcp-server:keygen","msg":"keygen failed","err":{"name":"Error","message":"tenant not found: self-host — start the stdio server once to create the self-host tenant, or seed the tenant first"}}
```

(A JSON log line on stderr — keygen keeps stdout clean for the key itself.)

So: start the stdio server once (step 4 of the [Quickstart](01-quickstart.md#4-talk-to-it-over-stdio)),
then mint the key:

```bash
docker compose run --rm -T mcp-server \
  node apps/mcp-server/dist/keygen.js self-host "laptop"
```

```
x6aeJY_0JShJ4xwnFqeF-4QCZSwpMRrA38V7kCyhFrM
```

The plaintext is printed **once** on stdout (logs go to stderr, so `| head -1` is clean).
Only its SHA-256 is stored. Lose it and you mint a new one; there is no recovery.

### Point a client at it

```bash
claude mcp add --transport http reconcil http://localhost:8484/mcp \
  --header "Authorization: Bearer x6aeJY_0JShJ4xwnFqeF-4QCZSwpMRrA38V7kCyhFrM"
```

Verify by hand if you like — note that streamable HTTP requires both content types in
`Accept`:

```bash
curl -X POST http://localhost:8484/mcp \
  -H "Authorization: Bearer $KEY" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

```
event: message
data: {"result":{"tools":[{"name":"analytics_balances", …
```

Responses are SSE-framed JSON-RPC. The transport runs **stateless**: one server instance per
request, so two tenants can never share session state.

### Before you expose it

The bearer scheme is deliberate minimalism for a pre-gate self-host product. If the port
leaves localhost:

- Terminate TLS in front of it. The server speaks plain HTTP.
- Treat the key as a full credential for that tenant's data. It carries no scopes and no
  expiry.
- Claude Desktop and claude.ai custom connectors require **OAuth**, which is post-gate
  (ADR-012). Until then, remote Desktop users are not supported; use Claude Code or stdio.

## The bundled CLI agent

The repo ships a thin agent for demos — the same tools bound in-process via the Anthropic
SDK Tool Runner, no server process in the loop:

```bash
export DATABASE_URL=postgres://postgres:<pw>@localhost:5432/reconcil
export ANTHROPIC_API_KEY=sk-ant-…
pnpm --filter @reconcil/cli dev repl
```

```
reconcil demo REPL — tenant "self-host", model claude-opus-4-8, today 2026-07-28.
Type /help for commands, /exit to quit.

you › how much USDC came in last month?
  → analytics_flows  [01KYMK0R0MXS2JA4AZ35NADTFR]
assistant › …
```

Each tool call prints its `tool_call_id`, so every figure in the answer stays traceable
(`/help`, `/reset`, `/exit`; `--model <id>` overrides the default). This is the only place
besides the eval harness that needs an Anthropic key — the server and worker never call an
LLM.

## Verifying the connection

Whatever the client, three checks confirm a healthy connection:

1. The tool list has **19** entries.
2. `ledger_status` returns without error (it works even with zero wallets tracked).
3. Every response carries a `citations.tool_call_id`.

If the tool count is different, the client is talking to a stale image — rebuild with
`docker compose up -d --build`.

## Next

- [Face A — analytics and reporting](03-face-a-analytics.md)
- [Face B — reconciliation](04-face-b-reconciliation.md)
- [Tool cheat sheet](06-tool-cheatsheet.md)

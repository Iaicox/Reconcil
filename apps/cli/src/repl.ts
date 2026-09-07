/**
 * Interactive demo REPL (P11): the conversational twin of the eval runner. It drives the
 * Anthropic Tool Runner over the same in-process MCP tool binding and system prompt as the
 * eval agent (agent/core.ts), but against a REAL, tenant-scoped database instead of a
 * fixture — the thing you show in the OSS demo. The LLM never computes (P1) and every
 * figure traces through the citation envelope (P2). The bound registry is read-only
 * analytics plus the two non-destructive, tenant-scoped writes (ledger_track_wallet,
 * directory upserts — P8); there is no signing or custody anywhere (the MiCA red line).
 * The Anthropic API key is needed only here and in the eval harness.
 *
 * Multi-turn is deliberately text-only: each turn seeds the runner with a copy of the
 * conversation so the runner's internal tool_use/tool_result rounds never leak into the
 * history we keep; we append only the user's question and the assistant's final text. That
 * keeps the transcript API-valid (no dangling tool_use blocks) and coherent across turns.
 */
import { createInterface } from 'node:readline/promises';

import Anthropic from '@anthropic-ai/sdk';
import { createDb, ensureSelfHostTenant } from '@reconcil/db';
import type { ToolContext } from '@reconcil/mcp-tools';
import { Pool } from 'pg';

import { buildRunnableTools, buildSystemPrompt, type Invocation } from './agent/core.js';
import { DEFAULT_MODEL } from './model.js';

/** One line of REPL input, classified. Slash commands are handled locally; everything else is a question. */
export type Command =
  | { kind: 'noop' }
  | { kind: 'exit' }
  | { kind: 'help' }
  | { kind: 'reset' }
  | { kind: 'unknown'; input: string }
  | { kind: 'ask'; text: string };

/** Classify a raw input line. Slash commands are case- and whitespace-insensitive. */
export function parseCommand(line: string): Command {
  const trimmed = line.trim();
  if (trimmed === '') return { kind: 'noop' };
  if (trimmed.startsWith('/')) {
    switch (trimmed.toLowerCase()) {
      case '/exit':
      case '/quit':
        return { kind: 'exit' };
      case '/help':
        return { kind: 'help' };
      case '/reset':
        return { kind: 'reset' };
      default:
        return { kind: 'unknown', input: trimmed };
    }
  }
  return { kind: 'ask', text: trimmed };
}

/** A compact one-line trace for a tool call: name + the tool_call_id that traces provenance (C2). */
export function renderInvocation(inv: Invocation): string {
  // tool_call_id is a required Citations field (C2) — every envelope carries it.
  return `  → ${inv.name}  [${inv.envelope.citations.tool_call_id}]`;
}

const HELP = `Commands:
  /help    show this help
  /reset   clear the conversation history
  /exit    quit (or Ctrl-D)
Anything else is asked to the assistant. Ask about balances, flows, gas,
counterparties, or stablecoin movements for the tracked wallets.`;

function modelFromArgv(argv: string[]): string {
  const i = argv.indexOf('--model');
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value !== undefined && value !== '' ? value : DEFAULT_MODEL;
}

/**
 * Run the interactive REPL. Reads DATABASE_URL, SELF_HOST_TENANT_SLUG/_NAME (same defaults
 * as the mcp-server), and ANTHROPIC_API_KEY from the environment; `--model <id>` overrides
 * the default. Not unit-tested (interactive I/O) — verified by a manual demo run.
 */
export async function runRepl(argv: string[] = process.argv.slice(3)): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error('DATABASE_URL is required — point the REPL at a running stack (docker compose up).');
    process.exitCode = 1;
    return;
  }
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ANTHROPIC_API_KEY is required to run the demo agent (the only place it is needed).');
    process.exitCode = 1;
    return;
  }

  const slug = process.env['SELF_HOST_TENANT_SLUG'] ?? 'self-host';
  const name = process.env['SELF_HOST_TENANT_NAME'] ?? 'Self-hosted';
  const model = modelFromArgv(argv);
  // Captured once at startup: a session left open across midnight keeps this date — fine for a demo.
  const referenceDate = new Date().toISOString().slice(0, 10);

  const client = new Anthropic();
  const pool = new Pool({ connectionString: databaseUrl });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => rl.close());

  try {
    const db = createDb(pool);
    const tenantId = await ensureSelfHostTenant(db, slug, name);
    const ctx: ToolContext = { db, tenantId };
    const history: Anthropic.Beta.BetaMessageParam[] = [];

    // ctx, the prompt, and the tool binding are fixed for the whole session — build once.
    const systemPrompt = buildSystemPrompt(referenceDate);
    const onInvocation = (inv: Invocation): void => {
      console.log(renderInvocation(inv));
    };
    const runnableTools = buildRunnableTools(ctx, onInvocation);

    console.log(`reconcil demo REPL — tenant "${slug}", model ${model}, today ${referenceDate}.`);
    console.log('Type /help for commands, /exit to quit.');

    for (;;) {
      let line: string;
      try {
        line = await rl.question('\nyou › ');
      } catch {
        break; // stdin closed (Ctrl-D) or the readline was aborted
      }

      const cmd = parseCommand(line);
      if (cmd.kind === 'exit') break;
      if (cmd.kind === 'noop') continue;
      if (cmd.kind === 'help') {
        console.log(HELP);
        continue;
      }
      if (cmd.kind === 'reset') {
        history.length = 0;
        console.log('(conversation reset)');
        continue;
      }
      if (cmd.kind === 'unknown') {
        console.log(`unknown command ${cmd.input} — type /help`);
        continue;
      }

      history.push({ role: 'user', content: cmd.text });

      let answer: string;
      try {
        const final = await client.beta.messages
          .toolRunner({
            model,
            max_tokens: 4096,
            max_iterations: 8,
            system: systemPrompt,
            tools: runnableTools,
            messages: [...history], // copy: the runner's internal rounds must not leak into our history
          })
          .runUntilDone();
        answer = final.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
          .trim();
      } catch (err) {
        console.error('agent error:', err instanceof Error ? err.message : String(err));
        history.pop(); // drop the unanswered user turn so the next turn stays consistent
        continue;
      }

      if (answer === '') {
        // No final text (e.g. the model stopped after tool calls). Don't store a synthetic
        // assistant turn; the unanswered user turn merges with the next question (API-legal).
        console.log('\nassistant › (no text response)');
        continue;
      }
      console.log(`\nassistant › ${answer}`);
      history.push({ role: 'assistant', content: answer });
    }
  } finally {
    rl.close();
    await pool.end().catch(() => {});
  }
}

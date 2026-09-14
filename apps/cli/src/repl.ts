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
import { EXIT_CANNOT_RUN, reportAndExit, unrunnableLines } from './evals/runnability.js';
import { UsageError } from './evals/usage-error.js';
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

/**
 * The REPL's argv, under the same discipline as `evals` (evals/args.ts).
 *
 * It was `argv.indexOf('--model')` + `argv[i + 1]`, which is the exact defect the `value()`
 * helper in args.ts carries a five-line docstring about, twenty lines away: `repl --model`
 * with the id forgotten fell back to the default in silence, and a mistyped `--modle opus`
 * was a no-op that ran the default model without a word — on the command that bills for
 * every turn. Fixed in one parser and left standing in the other.
 *
 * UsageError, so main.ts's catch classifies it as "the gate could not run, fix the
 * invocation" (exit 2) rather than letting a raw throw exit 1.
 */
export function parseReplArgs(argv: readonly string[]): { model: string } {
  let model = DEFAULT_MODEL;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') {
      const v = argv[++i];
      // `--model --verbose` would otherwise send "--verbose" to the API as a model id.
      if (v === undefined || v === '' || v.startsWith('--')) throw new UsageError('--model needs a value');
      model = v;
    } else if (a === '--') continue;
    else throw new UsageError(`unknown argument: ${String(a)}`);
  }
  return { model };
}

/**
 * Run the interactive REPL. Reads DATABASE_URL, SELF_HOST_TENANT_SLUG/_NAME (same defaults
 * as the mcp-server), and ANTHROPIC_API_KEY from the environment; `--model <id>` overrides
 * the default. Not unit-tested (interactive I/O) — verified by a manual demo run.
 */
export async function runRepl(argv: string[] = process.argv.slice(3)): Promise<void> {
  // FIRST, before the environment is consulted at all — the discipline the docstring on
  // parseReplArgs claims to share with the eval runner, where parseArgs is runEvals' first
  // statement. Placed after the two checks below, `repl --modle opus` on a machine with no
  // DATABASE_URL reported the missing variable and never mentioned the typo: the operator
  // fixes the environment, runs again, and only then learns the flag was wrong.
  const { model } = parseReplArgs(argv);

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    // Through reportAndExit at EXIT_CANNOT_RUN, not console.error + exitCode 1. "The
    // environment cannot support this run" is the textbook 2 under this branch's contract,
    // and 1 means "it ran and failed" — which is what both of these branches said. runEvals
    // routes the identical missing-key condition through this same reporter; one command
    // carrying both conventions is how the contract went false for the eval runner before.
    return reportAndExit(EXIT_CANNOT_RUN, unrunnableLines(
      {
        reason: 'DATABASE_URL is unset, and the REPL talks to a running stack',
        hint: 'start the stack (docker compose up) and point DATABASE_URL at it',
      },
      'repl',
    ));
  }
  if (!process.env['ANTHROPIC_API_KEY']) {
    return reportAndExit(EXIT_CANNOT_RUN, unrunnableLines(
      {
        reason: 'ANTHROPIC_API_KEY is unset, and the demo agent is the only thing that needs it',
        hint: 'set the key in the environment, then start the REPL again',
      },
      'repl',
    ));
  }

  const slug = process.env['SELF_HOST_TENANT_SLUG'] ?? 'self-host';
  const name = process.env['SELF_HOST_TENANT_NAME'] ?? 'Self-hosted';
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

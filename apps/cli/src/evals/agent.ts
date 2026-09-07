/**
 * The live-LLM half of the eval runner (04-testing.md §5): a fresh Anthropic Tool Runner
 * session per case, with the MCP tools bound IN-PROCESS over a fixture-seeded, tenant-
 * scoped ToolContext (ADR-012 — no server process in the loop). Each tool's citation
 * envelope is captured as it runs, yielding the Transcript the deterministic graders
 * consume. This is the ONLY component that calls the Anthropic API; everything downstream
 * is deterministic. The system prompt and in-process tool binding are shared with the demo
 * REPL via agent/core.ts.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolInvocation } from '@reconcil/evals';

import { buildRunnableTools, buildSystemPrompt } from '../agent/core.js';
import type { SessionInput, SessionProducer } from './types.js';

/** Pinned to the fixture-capture date so relative-window questions are deterministic. */
export const REFERENCE_DATE = '2026-07-17';

export interface AgentOptions {
  client: Anthropic;
  model: string;
  maxTokens?: number;
  maxIterations?: number;
  /**
   * Called with the model id the API actually answered with. `model` above may be an
   * undated alias, which silently re-points; the scorecard records what really ran so a
   * red gate can be told apart from a moved baseline.
   */
  onResolvedModel?: (model: string) => void;
  /**
   * Called once per API call with that call's token usage. The suite makes hundreds of
   * calls behind one `runUntilDone()`, so without this the only cost signal is the bill
   * arriving days later — and the cache breakpoint above could not be shown to work.
   */
  onUsage?: (usage: TokenUsage) => void;
}

/** The four counters that decide what a run costs. Cached input bills at a fraction of new input. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export function makeAgentProducer(opts: AgentOptions): SessionProducer {
  return async ({ eval: evalCase, ctx }: SessionInput) => {
    const invocations: ToolInvocation[] = [];
    const runnableTools = buildRunnableTools(ctx, (inv) => invocations.push(inv));

    const runner = opts.client.beta.messages
      .toolRunner({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        max_iterations: opts.maxIterations ?? 8,
        // One cache breakpoint, on the system block. The cached prefix is ordered
        // tools -> system -> messages, so a breakpoint here covers the 19 tool schemas
        // too (~5.5k tokens) — by far the largest fixed cost, re-sent on every iteration
        // of every case. It is byte-identical across all 90 sessions of a run, and each
        // read refreshes the TTL, so a sequential suite keeps it warm throughout.
        system: [
          {
            type: 'text',
            text: buildSystemPrompt(REFERENCE_DATE),
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: runnableTools,
        messages: [{ role: 'user', content: evalCase.question }],
      });

    // The runner is async-iterable and yields every assistant message, i.e. one per API
    // call; `runUntilDone()` afterwards returns the last of them. Iterating is the only
    // way to see per-call usage — the final message alone reports just its own.
    if (opts.onUsage) {
      for await (const message of runner) {
        opts.onUsage({
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          cacheCreation: message.usage.cache_creation_input_tokens ?? 0,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
        });
      }
    }
    const final = await runner.runUntilDone();

    opts.onResolvedModel?.(final.model);

    const finalAnswer = final.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    return { invocations, finalAnswer, referenceDate: REFERENCE_DATE };
  };
}

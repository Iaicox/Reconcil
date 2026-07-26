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
}

export function makeAgentProducer(opts: AgentOptions): SessionProducer {
  return async ({ eval: evalCase, ctx }: SessionInput) => {
    const invocations: ToolInvocation[] = [];
    const runnableTools = buildRunnableTools(ctx, (inv) => invocations.push(inv));

    const final = await opts.client.beta.messages
      .toolRunner({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        max_iterations: opts.maxIterations ?? 8,
        system: buildSystemPrompt(REFERENCE_DATE),
        tools: runnableTools,
        messages: [{ role: 'user', content: evalCase.question }],
      })
      .runUntilDone();

    const finalAnswer = final.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    return { invocations, finalAnswer, referenceDate: REFERENCE_DATE };
  };
}

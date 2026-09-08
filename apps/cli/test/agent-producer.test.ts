import type Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '@reconcil/mcp-tools';
import { describe, expect, it } from 'vitest';

import { makeAgentProducer, threadable, REFERENCE_DATE } from '../src/evals/agent.js';

/**
 * A stand-in for `client.beta.messages.toolRunner`. Our producer only needs `params` (the
 * accumulated conversation) and `runUntilDone()`: the usage loop is skipped when no
 * `onUsage` sink is passed, so nothing here has to be async-iterable. Each constructed
 * runner is recorded, which is how a "did turn 2 continue turn 1" question is answered.
 */
function fakeClient(answers: string[]): { client: Anthropic; seen: Anthropic.Beta.BetaMessageParam[][] } {
  const seen: Anthropic.Beta.BetaMessageParam[][] = [];
  let turn = 0;
  const client = {
    beta: {
      messages: {
        toolRunner: (params: { messages: Anthropic.Beta.BetaMessageParam[] }) => {
          const index = turn++;
          seen.push([...params.messages]);
          const assistant = { role: 'assistant', content: [{ type: 'text', text: answers[index] ?? '' }] };
          return {
            params: { ...params, messages: [...params.messages, assistant] },
            runUntilDone: () =>
              Promise.resolve({ model: 'claude-opus-4-8-fake', content: assistant.content }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, seen };
}

const CTX = { db: {}, tenantId: 't' } as unknown as ToolContext;

describe('makeAgentProducer', () => {
  it('runs a single-turn case as one session and returns its answer', async () => {
    const { client, seen } = fakeClient(['the balance is 1.5']);
    const produce = makeAgentProducer({ client, model: 'm' });
    const t = await produce({
      eval: { id: 'bal-x', face: 'A', question: 'balance?', expect: {} },
      ctx: CTX,
      runIndex: 0,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([{ role: 'user', content: 'balance?' }]);
    expect(t.finalAnswer).toBe('the balance is 1.5');
    expect(t.referenceDate).toBe(REFERENCE_DATE);
  });

  it('threads prior_turns into the graded turn instead of starting over', async () => {
    // trace-001's shape: the graded question is only answerable because an earlier turn
    // happened in the same conversation and left a tool_call behind.
    const { client, seen } = fakeClient(['gas was 0.021 ETH', 'here is the trace']);
    const produce = makeAgentProducer({ client, model: 'm' });
    const t = await produce({
      eval: {
        id: 'trace-x',
        face: 'A',
        prior_turns: ['what did I spend on gas?'],
        question: 'how did you arrive at that?',
        expect: {},
      },
      ctx: CTX,
      runIndex: 0,
    });

    expect(seen).toHaveLength(2);
    // Turn 2 carries turn 1's question AND its answer, then the graded question last.
    expect(seen[1]).toEqual([
      { role: 'user', content: 'what did I spend on gas?' },
      { role: 'assistant', content: [{ type: 'text', text: 'gas was 0.021 ETH' }] },
      { role: 'user', content: 'how did you arrive at that?' },
    ]);
    // The graded answer is the LAST turn's, not the first.
    expect(t.finalAnswer).toBe('here is the trace');
  });

  it('reports the model that answered the graded turn', async () => {
    const resolved: string[] = [];
    const { client } = fakeClient(['a', 'b']);
    const produce = makeAgentProducer({ client, model: 'm', onResolvedModel: (m) => resolved.push(m) });
    await produce({
      eval: { id: 'x', face: 'A', prior_turns: ['first'], question: 'second', expect: {} },
      ctx: CTX,
      runIndex: 0,
    });
    expect(resolved).toEqual(['claude-opus-4-8-fake']);
  });
});

describe('threadable', () => {
  const text = (t: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text: t }] });
  const asksTool = { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'tu_1', name: 'x', input: {} }] };
  const answersTool = {
    role: 'user' as const,
    content: [{ type: 'tool_result' as const, tool_use_id: 'tu_1', content: 'ok' }],
  };

  it('leaves a normally-ended conversation alone', () => {
    const convo = [{ role: 'user' as const, content: 'q' }, asksTool, answersTool, text('done')];
    expect(threadable(convo)).toEqual(convo);
  });

  it('drops a trailing tool_use nothing answered — appending a user turn after it is a 400', () => {
    // The runner stops on max_iterations and on a refusal stop_reason, either of which can
    // leave the last assistant message asking for a tool that never got its result. Since
    // an unhandled throw now aborts the whole SUITE, one capped prior turn would cost every
    // case after it.
    const convo = [{ role: 'user' as const, content: 'q' }, answersTool, asksTool];
    expect(threadable(convo)).toEqual([{ role: 'user' as const, content: 'q' }, answersTool]);
  });

  it('keeps dropping while the tail is still unanswered', () => {
    expect(threadable([{ role: 'user' as const, content: 'q' }, asksTool, asksTool])).toEqual([
      { role: 'user' as const, content: 'q' },
    ]);
  });
});

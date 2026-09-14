import type { ToolEnvelope } from '@reconcil/mcp-tools';
import { describe, expect, it } from 'vitest';

import type { Invocation } from '../src/agent/core.js';
import { UsageError } from '../src/evals/usage-error.js';
import { DEFAULT_MODEL } from '../src/model.js';
import { parseCommand, parseReplArgs, renderInvocation } from '../src/repl.js';

describe('parseCommand', () => {
  it('treats a blank line as a no-op', () => {
    expect(parseCommand('')).toEqual({ kind: 'noop' });
    expect(parseCommand('   ')).toEqual({ kind: 'noop' });
  });

  it('recognises /exit and /quit (whitespace- and case-insensitive)', () => {
    expect(parseCommand('/exit')).toEqual({ kind: 'exit' });
    expect(parseCommand('  /quit ')).toEqual({ kind: 'exit' });
    expect(parseCommand('/EXIT')).toEqual({ kind: 'exit' });
  });

  it('recognises /help and /reset', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
    expect(parseCommand('/reset')).toEqual({ kind: 'reset' });
  });

  it('flags an unknown slash command rather than sending it to the model', () => {
    expect(parseCommand('/bogus')).toEqual({ kind: 'unknown', input: '/bogus' });
  });

  it('treats anything else as a question, trimmed', () => {
    expect(parseCommand('what is my ETH balance?')).toEqual({ kind: 'ask', text: 'what is my ETH balance?' });
    expect(parseCommand('  gas total  ')).toEqual({ kind: 'ask', text: 'gas total' });
  });
});

describe('renderInvocation', () => {
  const envelope = (id: string): ToolEnvelope<unknown> => ({
    data: {},
    citations: { tool_call_id: id, coverage: [] },
    warnings: [],
    meta: { schema_version: 1, computed_at: '2026-07-24T00:00:00.000Z', units: 'decimal-string' },
  });

  it('shows the tool name and its tool_call_id as a one-line trace', () => {
    const inv: Invocation = { name: 'analytics_balances', args: {}, envelope: envelope('tc-9') };
    const line = renderInvocation(inv);
    expect(line).toContain('analytics_balances');
    expect(line).toContain('tc-9');
  });
});

describe('parseReplArgs', () => {
  it('defaults to the pinned model', () => {
    expect(parseReplArgs([]).model).toBe(DEFAULT_MODEL);
    expect(parseReplArgs(['--']).model).toBe(DEFAULT_MODEL);
  });

  it('takes an explicit --model', () => {
    expect(parseReplArgs(['--model', 'claude-x']).model).toBe('claude-x');
  });

  it('refuses --model with the value forgotten instead of silently defaulting', () => {
    // `argv.indexOf('--model')` + `argv[i + 1]` fell back to the default without a word, and
    // `--model --verbose` sent "--verbose" to the API as a model id. Same defect args.ts's
    // `value()` helper exists for, left standing in the second parser.
    for (const argv of [['--model'], ['--model', ''], ['--model', '--verbose']]) {
      expect(() => parseReplArgs(argv), argv.join(' ')).toThrow(UsageError);
      expect(() => parseReplArgs(argv), argv.join(' ')).toThrow(/--model needs a value/);
    }
  });

  it('refuses an unknown flag rather than running the default model in silence', () => {
    expect(() => parseReplArgs(['--modle', 'opus'])).toThrow(/unknown argument: --modle/);
  });
});

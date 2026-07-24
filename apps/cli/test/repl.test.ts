import type { ToolEnvelope } from '@pet-crypto/mcp-tools';
import { describe, expect, it } from 'vitest';

import type { Invocation } from '../src/agent/core.js';
import { parseCommand, renderInvocation } from '../src/repl.js';

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
  const envelope = (id?: string): ToolEnvelope<unknown> => ({
    data: {},
    citations: id === undefined ? { coverage: [] } : { tool_call_id: id, coverage: [] },
    warnings: [],
    meta: { schema_version: 1, computed_at: '2026-07-24T00:00:00.000Z', units: 'decimal-string' },
  });

  it('shows the tool name and its tool_call_id as a one-line trace', () => {
    const inv: Invocation = { name: 'analytics_balances', args: {}, envelope: envelope('tc-9') };
    const line = renderInvocation(inv);
    expect(line).toContain('analytics_balances');
    expect(line).toContain('tc-9');
  });

  it('marks a missing tool_call_id rather than printing undefined', () => {
    const inv: Invocation = { name: 'directory_list_entities', args: {}, envelope: envelope() };
    expect(renderInvocation(inv)).toContain('no id');
  });
});

import { describe, expect, it } from 'vitest';

import { toCsv } from '../src/index.js';

describe('toCsv — RFC-4180 serialization', () => {
  it('emits a header + rows with LF endings and a trailing newline', () => {
    const out = toCsv(['a', 'b'], [['1', '2'], ['3', '4']]);
    expect(out).toBe('a,b\n1,2\n3,4\n');
  });

  it('quotes fields containing a delimiter, quote, or newline; doubles internal quotes', () => {
    const out = toCsv(['x'], [['a,b'], ['say "hi"'], ['line1\nline2'], ['carriage\rreturn']]);
    expect(out).toBe('x\n"a,b"\n"say ""hi"""\n"line1\nline2"\n"carriage\rreturn"\n');
  });

  it('quotes fields with leading/trailing whitespace a parser would trim', () => {
    expect(toCsv(['x'], [[' pad ']])).toBe('x\n" pad "\n');
  });

  it('serializes integer numbers but refuses non-integer numbers (money must be a string, ADR-004)', () => {
    expect(toCsv(['n'], [[42]])).toBe('n\n42\n');
    expect(() => toCsv(['n'], [[3.14]])).toThrow(/decimal string/);
  });
});

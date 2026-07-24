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

  it('neutralizes formula-injection leads with a prefixed apostrophe (CWE-1236)', () => {
    // Hostile token symbols / cells that a spreadsheet would evaluate as a formula.
    expect(toCsv(['x'], [['=cmd']])).toBe("x\n'=cmd\n");
    expect(toCsv(['x'], [['@x']])).toBe("x\n'@x\n");
    expect(toCsv(['x'], [['-2+3']])).toBe("x\n'-2+3\n");
    // '+' and '(' survive the core sanitizer.
    expect(toCsv(['x'], [['+SUM(1)']])).toBe("x\n'+SUM(1)\n");
    // A payload with a comma is guarded AND quoted.
    expect(toCsv(['x'], [['=HYPERLINK(1,2)']])).toBe('x\n"\'=HYPERLINK(1,2)"\n');
  });

  it('leaves real numeric literals untouched (signed money, log_index sentinels)', () => {
    expect(toCsv(['n'], [['-6000.00']])).toBe('n\n-6000.00\n');
    expect(toCsv(['n'], [['-1']])).toBe('n\n-1\n'); // log_index sentinel
    expect(toCsv(['n'], [['0']])).toBe('n\n0\n');
  });
});

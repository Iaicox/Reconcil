import { describe, expect, it } from 'vitest';

import { decimalString } from '@reconcil/core';

import { formatDefaultVatRate } from '../src/tools/recon-import-invoices.js';

describe('formatDefaultVatRate — no exponential notation (hermetic)', () => {
  it('rewrites a small number that String() would render exponential', () => {
    expect(formatDefaultVatRate(1e-7)).toBe('0.0000001');
    expect(String(1e-7)).toBe('1e-7'); // the bug this guards against
  });

  it('leaves already-plain numbers untouched', () => {
    expect(formatDefaultVatRate(21)).toBe('21');
    expect(formatDefaultVatRate(21.5)).toBe('21.5');
    expect(formatDefaultVatRate(7.7)).toBe('7.7'); // a real-world VAT rate (CH)
    expect(formatDefaultVatRate(0)).toBe('0');
  });

  it('handles a large exponent without truncation', () => {
    expect(formatDefaultVatRate(1e21)).toBe(`1${'0'.repeat(21)}`);
  });

  it('always yields a string the decimal-string schema accepts', () => {
    for (const n of [1e-7, 1.23e-8, 21, 7.7, 100, 0]) {
      expect(decimalString.safeParse(formatDefaultVatRate(n)).success).toBe(true);
    }
  });
});

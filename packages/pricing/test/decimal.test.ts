import { describe, expect, it } from 'vitest';

import { divide, multiply, roundHalfUp } from '../src/decimal.js';

describe('decimal — exact money arithmetic (ADR-004)', () => {
  it('multiplies exactly, with no binary-float drift', () => {
    expect(multiply('1523.42', '2.5')).toBe('3808.55');
    expect(multiply('0.1', '0.2')).toBe('0.02'); // JS float would give 0.020000000000000004
  });

  it('keeps full precision on non-terminating division — rounds only at export', () => {
    // 100 USD ÷ 1.08 (EUR→USD) = 92.5925925925…  kept at full internal precision
    const v = divide('100', '1.08');
    expect(v.startsWith('92.59259259259259')).toBe(true);
    expect(v.length).toBeGreaterThan(20); // NOT prematurely rounded to 2dp
  });

  it('rounds half-up only when explicitly asked (the export boundary)', () => {
    expect(roundHalfUp('2.345', 2)).toBe('2.35');
    expect(roundHalfUp('2.344', 2)).toBe('2.34');
    expect(roundHalfUp(divide('100', '1.08'), 2)).toBe('92.59');
  });

  it('never emits exponent notation for very small or large magnitudes', () => {
    expect(multiply('0.00000001', '0.00000001')).not.toContain('e');
    expect(multiply('100000000000000000000', '100000000000000000000')).not.toContain('e');
  });
});

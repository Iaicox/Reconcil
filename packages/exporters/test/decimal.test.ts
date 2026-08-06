import { describe, expect, it } from 'vitest';

import { compareDecimals, isZero, roundHalfUp } from '../src/index.js';

describe('compareDecimals — float-free ordering', () => {
  it('orders decimal strings without a Number() round-trip', () => {
    expect(compareDecimals('10', '9')).toBe(1);
    expect(compareDecimals('9', '10')).toBe(-1);
    expect(compareDecimals('2000.00', '2000.00')).toBe(0);
    // A pair that a float compare could get wrong at high precision, but decimal does not.
    expect(compareDecimals('1000000000000000000.2', '1000000000000000000.1')).toBe(1);
    // usable as a descending Array#sort comparator
    expect(['3', '1', '2'].sort((a, b) => compareDecimals(b, a))).toEqual(['3', '2', '1']);
  });
});

describe('roundHalfUp — export-boundary rounding', () => {
  it('rounds half-up to the given dp', () => {
    expect(roundHalfUp('500.005', 2)).toBe('500.01');
    expect(roundHalfUp('-6000', 2)).toBe('-6000.00');
  });
});

describe('isZero — the export-edge zero test (never `Number(x) !== 0`, money is not `number`)', () => {
  it('treats both "0.00" and "-0.00" as zero', () => {
    // This is exactly the case a `Number()` coercion masked at the mcp-tools edge:
    // `Number("-0.00") !== 0` is also `false`, so behavior did not change — but the
    // point is the red line (money never through `number`), so both are asserted here.
    expect(isZero('0.00')).toBe(true);
    expect(isZero('-0.00')).toBe(true);
    expect(isZero('0')).toBe(true);
  });

  it('is false for any non-zero decimal string', () => {
    expect(isZero('0.01')).toBe(false);
    expect(isZero('-0.01')).toBe(false);
  });
});

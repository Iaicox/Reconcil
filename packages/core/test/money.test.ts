import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatUnits, parseUnits } from '../src/index.js';

const MAX_UINT256 = 2n ** 256n - 1n;

describe('formatUnits', () => {
  it('returns "0" for zero regardless of decimals', () => {
    expect(formatUnits(0n, 18)).toBe('0');
    expect(formatUnits(0n, 0)).toBe('0');
  });

  it('formats a whole number of base units with no fractional part', () => {
    expect(formatUnits(10n ** 18n, 18)).toBe('1');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
  });

  it('trims trailing zeros in the fractional part (canonical-minimal)', () => {
    expect(formatUnits(1_523_420_000n, 6)).toBe('1523.42');
  });

  it('left-pads when decimals exceed the significant digits', () => {
    expect(formatUnits(5n, 18)).toBe('0.000000000000000005');
  });

  it('treats decimals=0 as a plain integer', () => {
    expect(formatUnits(1234n, 0)).toBe('1234');
  });

  it('emits a leading minus for negative amounts (net flows can be negative)', () => {
    expect(formatUnits(-1_500_000n, 6)).toBe('-1.5');
    expect(formatUnits(-(10n ** 18n), 18)).toBe('-1');
  });

  it('is exact across the full uint256 range', () => {
    const out = formatUnits(MAX_UINT256, 18);
    const [intPart, frac] = out.split('.');
    // Independent check via bigint division/mod (not formatUnits internals).
    expect(intPart).toBe(String(MAX_UINT256 / 10n ** 18n));
    expect(BigInt(frac ?? '0')).toBe(MAX_UINT256 % 10n ** 18n);
  });
});

describe('parseUnits', () => {
  it('inverts formatUnits for representative values', () => {
    expect(parseUnits('1523.42', 6)).toBe(1_523_420_000n);
    expect(parseUnits('1', 18)).toBe(10n ** 18n);
    expect(parseUnits('-1.5', 6)).toBe(-1_500_000n);
    expect(parseUnits('0', 18)).toBe(0n);
  });

  it('rejects a fractional part longer than decimals (would lose precision)', () => {
    expect(() => parseUnits('1.1234567', 6)).toThrow();
  });
});

describe('formatUnits / parseUnits round-trip', () => {
  it('parseUnits(formatUnits(raw, d), d) === raw for arbitrary raw and decimals', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -MAX_UINT256, max: MAX_UINT256 }),
        fc.integer({ min: 0, max: 36 }),
        (raw, decimals) => {
          expect(parseUnits(formatUnits(raw, decimals), decimals)).toBe(raw);
        },
      ),
    );
  });
});

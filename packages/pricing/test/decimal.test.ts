import { describe, expect, it } from 'vitest';

import { divide, multiply, numberToDecimalString, roundHalfUp } from '../src/decimal.js';
import { parseDefiLlama } from '../src/providers/defillama.js';
import { parseJsonPreservingNumbers } from '../src/providers/transport.js';

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

describe('numberToDecimalString — provider precision', () => {
  it('keeps every digit a provider quoted when given the source text', () => {
    // The exact case the float path loses: JSON.parse rounds this to
    // 0.12345678901234568, so the snapshot we pin would differ from the quote.
    expect(numberToDecimalString('0.1234567890123456789')).toBe('0.1234567890123456789');
    // Written through Number() rather than as a literal: the value cannot survive as a
    // float, which is the whole point — and no-loss-of-precision rightly rejects the
    // literal form. This is what the old path stored.
    expect(numberToDecimalString(Number('0.1234567890123456789'))).toBe('0.12345678901234568');
  });

  it('still accepts a parsed number, for fixtures recorded before the source text was kept', () => {
    expect(numberToDecimalString(2500.5)).toBe('2500.5');
    expect(numberToDecimalString(0)).toBe('0');
  });

  it('normalises exponent form out of both inputs', () => {
    expect(numberToDecimalString('1.5e-7')).toBe('0.00000015');
    expect(numberToDecimalString(1.5e-7)).toBe('0.00000015');
  });

  it('rejects an overflowing exponent rather than pinning a nonsense price', () => {
    // Both used to be rejected because JSON.parse had already collapsed them to Infinity.
    // Keeping the source text must not quietly widen the accepted MAGNITUDE: past
    // decimal.js's maxE this returns the literal string 'Infinity', and below it a
    // 10,001-digit price — either one pinned into price_snapshots instead of failing
    // over to the next provider.
    expect(numberToDecimalString('1e999999999999999999')).toBeNull();
    expect(numberToDecimalString('1e10000')).toBeNull();
    expect(numberToDecimalString('-1e10000')).toBeNull();
    // A large but float-representable magnitude is accepted, exactly as before.
    expect(numberToDecimalString('1e300')).toBe(`1${'0'.repeat(300)}`);
  });

  it('rejects a string that is not a JSON number, so a symbol never becomes a price', () => {
    expect(numberToDecimalString('USD')).toBeNull();
    expect(numberToDecimalString('')).toBeNull();
    expect(numberToDecimalString('12abc')).toBeNull();
    expect(numberToDecimalString('0x10')).toBeNull();
    expect(numberToDecimalString('Infinity')).toBeNull();
  });

  it('rejects non-finite and non-numeric values', () => {
    expect(numberToDecimalString(Number.NaN)).toBeNull();
    expect(numberToDecimalString(Number.POSITIVE_INFINITY)).toBeNull();
    expect(numberToDecimalString(undefined)).toBeNull();
    expect(numberToDecimalString(null)).toBeNull();
    expect(numberToDecimalString({})).toBeNull();
  });
});

describe('parseJsonPreservingNumbers', () => {
  it('hands numbers over as their source text, leaving everything else alone', () => {
    const body = parseJsonPreservingNumbers('{"coins":{"eth":{"price":2500.123456789012345678,"ok":true,"sym":"ETH"}}}');
    const coin = (body as { coins: Record<string, { price: unknown; ok: unknown; sym: unknown }> }).coins['eth']!;
    expect(coin.price).toBe('2500.123456789012345678');
    expect(coin.ok).toBe(true);
    expect(coin.sym).toBe('ETH');
  });

  it('round-trips through the provider parser to an exact snapshot value', () => {
    const body = parseJsonPreservingNumbers('{"coins":{"ethereum:0xabc":{"price":0.1234567890123456789}}}');
    expect(parseDefiLlama(body, 'ethereum:0xabc')).toEqual({
      price: '0.1234567890123456789',
      currency: 'USD',
    });
  });
});

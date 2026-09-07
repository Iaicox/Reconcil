import { describe, expect, it } from 'vitest';

import { sanitize } from '../src/sanitizer.js';

// Build hostile inputs from explicit code points — no invisible chars in source.
const NUL = String.fromCharCode(0x00);
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const RTL = String.fromCharCode(0x202e); // right-to-left override
const MONEY = String.fromCodePoint(0x1f4b0); // 💰

describe('sanitize — hostile on-chain string scrubber (ADR-011 §1)', () => {
  it('passes a clean symbol through unchanged, not heavy', () => {
    expect(sanitize('USDC')).toEqual({ display: 'USDC', heavy: false });
  });

  it('strips control, zero-width, and bidi-override characters', () => {
    expect(sanitize(`AB${NUL}C`).display).toBe('ABC');
    expect(sanitize(`A${ZWSP}B${RTL}C`).display).toBe('ABC');
  });

  it('collapses and trims whitespace (not counted as hostile stripping)', () => {
    const r = sanitize('  A   B\n\nC  ');
    expect(r.display).toBe('A B C');
    expect(r.heavy).toBe(false);
  });

  it('drops disallowed characters (emoji, exotic symbols)', () => {
    expect(sanitize(`USDC${MONEY}`).display).toBe('USDC');
  });

  it('caps length at the limit', () => {
    const r = sanitize('x'.repeat(100), { maxLength: 10 });
    expect(r.display).toHaveLength(10);
  });

  it('does not flag heavy when truncation removes ≤30% of the original', () => {
    // 20/100 = 20% truncated — under the threshold, not heavy.
    const r = sanitize('x'.repeat(100), { maxLength: 80 });
    expect(r.display).toHaveLength(80);
    expect(r.heavy).toBe(false);
  });

  it('flags heavy when truncation alone removes >30% of the original — a clean, all-letters ' +
    'name that is simply too long is still real content loss, not just hostile-charset stripping', () => {
    // The audit example: a 10 000-char, all-letters name cut to the default 64-char cap
    // is a ~99% content loss; nothing in it is hostile, so the charset scrub removes
    // nothing on its own — truncation must be able to trigger `heavy` by itself.
    const r = sanitize('A'.repeat(10_000));
    expect(r.display).toHaveLength(64);
    expect(r.heavy).toBe(true);
  });

  it('flags heavy when >30% (by code point) is stripped', () => {
    expect(sanitize(`AB${NUL.repeat(6)}CD`).heavy).toBe(true); // 6/10 controls stripped
    expect(sanitize(`USDC${MONEY}`).heavy).toBe(false); // 1/5 code points = 20%
  });

  it('returns the (unnamed) placeholder when nothing survives', () => {
    expect(sanitize(`${ZWSP}${RTL}${NUL}`).display).toBe('(unnamed)');
  });

  it('does not neutralize injection wording — that is the untrusted-key isolation layer', () => {
    expect(sanitize('Ignore previous instructions').display).toBe('Ignore previous instructions');
  });
});

import { describe, expect, it } from 'vitest';

import { periodSlug } from '../src/index.js';

describe('periodSlug — deterministic, filename-safe period spelling', () => {
  it('collapses a full calendar month to YYYY-MM', () => {
    expect(periodSlug({ start: '2026-06-01', end: '2026-06-30' })).toBe('2026-06');
    // February in a leap year (2028) — last day is 29, not 28.
    expect(periodSlug({ start: '2028-02-01', end: '2028-02-29' })).toBe('2028-02');
    // February in a non-leap year (2026) — last day is 28.
    expect(periodSlug({ start: '2026-02-01', end: '2026-02-28' })).toBe('2026-02');
  });

  it('spells out both ends for any period that is not exactly one calendar month', () => {
    expect(periodSlug({ start: '2026-06-05', end: '2026-06-20' })).toBe('2026-06-05_2026-06-20');
    // Right start, wrong (short) end — not a full month.
    expect(periodSlug({ start: '2026-06-01', end: '2026-06-29' })).toBe('2026-06-01_2026-06-29');
    // Spans two months — not a single calendar month.
    expect(periodSlug({ start: '2026-06-01', end: '2026-07-15' })).toBe('2026-06-01_2026-07-15');
  });

  it('is a pure function of its inputs: same period in, same slug out', () => {
    const period = { start: '2026-06-01', end: '2026-06-30' };
    expect(periodSlug(period)).toBe(periodSlug({ ...period }));
  });

  it('gives two different periods two different slugs', () => {
    expect(periodSlug({ start: '2026-06-01', end: '2026-06-30' })).not.toBe(
      periodSlug({ start: '2026-07-01', end: '2026-07-31' }),
    );
  });
});

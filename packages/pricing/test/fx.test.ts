import { describe, expect, it } from 'vitest';

import { pickLatestRate } from '../src/fx.js';
import type { FxRow } from '../src/types.js';

const r = (id: number, rateDate: string, source = 'ecb'): FxRow =>
  ({ id, rateDate, baseCurrency: 'EUR', quoteCurrency: 'USD', rate: '1.08', source });

describe('pickLatestRate — latest ECB rate ≤ target date (weekend/holiday rule)', () => {
  it('exact date: not shifted', () => {
    const rows = [r(3, '2026-06-01'), r(2, '2026-05-29')];
    expect(pickLatestRate(rows, '2026-06-01')).toEqual({ row: rows[0], shifted: false });
  });

  it('weekend: uses the latest prior business day and marks shifted', () => {
    const rows = [r(2, '2026-05-29')]; // 2026-05-31 is a Sunday → Friday 05-29
    expect(pickLatestRate(rows, '2026-05-31')).toEqual({ row: rows[0], shifted: true });
  });

  it('ignores rows after the target date (order-independent)', () => {
    const rows = [r(3, '2026-06-01'), r(4, '2026-06-05')];
    expect(pickLatestRate(rows, '2026-06-02')).toEqual({ row: rows[0], shifted: true });
  });

  it('returns undefined when no rate ≤ date exists', () => {
    expect(pickLatestRate([r(1, '2026-06-10')], '2026-06-01')).toBeUndefined();
  });
});

describe('pickLatestRate — same-date multi-source tie-break (H4 determinism)', () => {
  it('prefers `manual` over `ecb` for the same date, regardless of row order', () => {
    const manual = r(10, '2026-06-01', 'manual');
    const ecb = r(11, '2026-06-01', 'ecb');
    expect(pickLatestRate([ecb, manual], '2026-06-01')).toEqual({ row: manual, shifted: false });
    expect(pickLatestRate([manual, ecb], '2026-06-01')).toEqual({ row: manual, shifted: false });
  });

  it('ranks an unknown source after `ecb`, and ties among unknown sources alphabetically', () => {
    const ecb = r(20, '2026-06-01', 'ecb');
    const zzz = r(21, '2026-06-01', 'zzz');
    const aaa = r(22, '2026-06-01', 'aaa');
    expect(pickLatestRate([zzz, ecb, aaa], '2026-06-01')).toEqual({ row: ecb, shifted: false });
    expect(pickLatestRate([zzz, aaa], '2026-06-01')).toEqual({ row: aaa, shifted: false });
  });

  it('falls back to the highest `id` as the final tiebreak when source is identical', () => {
    const older = r(30, '2026-06-01', 'ecb');
    const newer = r(31, '2026-06-01', 'ecb');
    expect(pickLatestRate([newer, older], '2026-06-01')).toEqual({ row: newer, shifted: false });
    expect(pickLatestRate([older, newer], '2026-06-01')).toEqual({ row: newer, shifted: false });
  });

  it('is fully order-independent across permutations of a mixed-source, same-date row set', () => {
    const manual = r(40, '2026-06-01', 'manual');
    const ecb = r(41, '2026-06-01', 'ecb');
    const other = r(42, '2026-06-01', 'xyz');
    const perms = [
      [manual, ecb, other], [manual, other, ecb], [ecb, manual, other],
      [ecb, other, manual], [other, manual, ecb], [other, ecb, manual],
    ];
    for (const rows of perms) {
      expect(pickLatestRate(rows, '2026-06-01')).toEqual({ row: manual, shifted: false });
    }
  });
});

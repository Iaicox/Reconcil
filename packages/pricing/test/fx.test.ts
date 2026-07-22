import { describe, expect, it } from 'vitest';

import { pickLatestRate } from '../src/fx.js';
import type { FxRow } from '../src/types.js';

const r = (id: number, rateDate: string): FxRow =>
  ({ id, rateDate, baseCurrency: 'EUR', quoteCurrency: 'USD', rate: '1.08', source: 'ecb' });

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

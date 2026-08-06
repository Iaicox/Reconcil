import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { balanceJournal, buildJournalDraft, type JournalLine } from '../src/index.js';

function totals(lines: JournalLine[]): { debit: Decimal; credit: Decimal } {
  return {
    debit: lines.reduce((a, l) => a.plus(l.debit), new Decimal(0)),
    credit: lines.reduce((a, l) => a.plus(l.credit), new Decimal(0)),
  };
}

describe('buildJournalDraft — Face A minimal draft', () => {
  it('parks net movements against Suspense and gas against Network Fees, balanced', () => {
    const r = buildJournalDraft(
      { movements: [{ tokenSymbol: 'ETH', netFiat: '-6000' }, { tokenSymbol: 'USDC', netFiat: '500.004' }], gasFiat: '2000' },
      'USD',
      '2026-06-30',
    );
    const { debit, credit } = totals(r.lines);
    expect(debit.equals(credit)).toBe(true);
    expect(r.residue).toBe('0.00');
    // half-up 2dp rounding at the boundary: 500.004 → 500.00
    const suspense = r.lines.find((l) => l.account === 'Suspense — unclassified' && l.debit !== '0.00');
    expect(suspense?.debit).toBe('6000.00');
    expect(r.lines.some((l) => l.account === 'Network Fees (gas)' && l.debit === '2000.00')).toBe(true);
  });

  it('skips zero movements and omits gas when absent', () => {
    const r = buildJournalDraft({ movements: [{ tokenSymbol: 'DAI', netFiat: '0' }] }, 'EUR', '2026-06-30');
    expect(r.lines).toHaveLength(0);
    expect(r.residue).toBe('0.00');
  });

  it('throws on a negative gasFiat instead of silently sign-flipping', () => {
    expect(() =>
      buildJournalDraft({ movements: [], gasFiat: '-50.00' }, 'USD', '2026-06-30'),
    ).toThrow(/gasFiat/);
  });

  it('skips an effectively-zero (negative-rounds-to-zero) gasFiat instead of throwing', () => {
    // roundHalfUp('-0.001', 2) === '-0.00', and isNegative('-0.00') is true — isZero
    // MUST be checked before isNegative (matching entryLines) or this throws instead
    // of being skipped like any other zero-valued gas.
    const r = buildJournalDraft({ movements: [], gasFiat: '-0.001' }, 'USD', '2026-06-30');
    expect(r.lines).toHaveLength(0);
    expect(r.residue).toBe('0.00');
  });
});

describe('balanceJournal — the balance guarantee (invariant #8)', () => {
  it('always appends a Rounding line so debits == credits exactly', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            debit: fc.integer({ min: 0, max: 1_000_000 }),
            credit: fc.integer({ min: 0, max: 1_000_000 }),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (raw) => {
          // 2dp lines (cents), as the real journal produces.
          const lines: JournalLine[] = raw.map((r) => ({
            date: '2026-06-30',
            account: 'X',
            description: 'test',
            debit: (r.debit / 100).toFixed(2),
            credit: (r.credit / 100).toFixed(2),
            currency: 'USD',
          }));
          const out = balanceJournal(lines, 'USD', '2026-06-30');
          const { debit, credit } = totals(out.lines);
          expect(debit.toFixed(2)).toBe(credit.toFixed(2));
          expect(out.residue).toBe('0.00');
          // at most one rounding line was added
          expect(out.lines.length).toBeLessThanOrEqual(lines.length + 1);
        },
      ),
    );
  });
});

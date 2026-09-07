import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  renderJournalDrafts,
  type JournalDraftsInput,
  type JournalEntryInput,
  type JournalManifest,
  type RenderedFile,
} from '../src/index.js';

function provenance(): JournalDraftsInput['provenance'] {
  return {
    exportId: 'test-export-id',
    toolCallId: 'test-tool-call',
    generatedAt: '2026-07-01T00:00:00.000Z',
    coverage: [],
    priceRefs: [],
    fxRefs: [],
  };
}

function input(over: Partial<JournalDraftsInput> & { entries: JournalEntryInput[] }): JournalDraftsInput {
  return {
    target: 'qbo',
    period: { start: '2026-06-01', end: '2026-06-30' },
    scope: { addresses: ['0xaaa'], clientId: null },
    provenance: provenance(),
    ...over,
  };
}

function text(f: RenderedFile): string {
  if (typeof f.content !== 'string') throw new Error('expected a text file');
  return f.content;
}

/** Sum debit/credit columns per currency straight off the emitted CSV body. */
function columnTotals(csv: string, target: 'qbo' | 'xero'): Map<string, { debit: Decimal; credit: Decimal }> {
  const [, ...rows] = csv.trimEnd().split('\n');
  const debitCol = target === 'qbo' ? 3 : 4;
  const creditCol = target === 'qbo' ? 4 : 5;
  const curCol = 6;
  const acc = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const row of rows) {
    const cells = row.split(',');
    const cur = cells[curCol];
    if (cur === undefined || cur === '') continue; // banner row
    const bucket = acc.get(cur) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    bucket.debit = bucket.debit.plus(cells[debitCol] || '0');
    bucket.credit = bucket.credit.plus(cells[creditCol] || '0');
    acc.set(cur, bucket);
  }
  return acc;
}

const MAPPING = { crypto_asset: '1010', accounts_receivable: '1100', accounts_payable: '2000', vat_output: '2200', vat_input: '1300' };

describe('renderJournalDrafts — recon-backed QBO/Xero draft (§6.5)', () => {
  it('splits a receivable with VAT into asset / net receivable / output VAT (QBO)', () => {
    const out = renderJournalDrafts(
      input({
        target: 'qbo',
        accountMapping: MAPPING,
        entries: [
          { externalRef: 'INV-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' },
        ],
      }),
    );
    expect(text(out.file)).toBe(
      '*JournalNo,*JournalDate,*AccountName,Debits,Credits,Description,Currency\n' +
        'DRAFT — REVIEW REQUIRED,,,,,,\n' +
        '1,2026-06-15,1010,1000.00,0.00,INV-1 — ACME,EUR\n' +
        '1,2026-06-15,1100,0.00,826.45,INV-1 — ACME,EUR\n' +
        '1,2026-06-15,2200,0.00,173.55,INV-1 — ACME,EUR\n',
    );
    expect(out.lines).toBe(3);
    expect(out.unmappedCategories).toEqual([]);
    expect(out.file.name).toBe('journal_draft_qbo_2026-06_DRAFT.csv');
  });

  it('splits a payable with VAT into net payable / input VAT / asset credit (Xero)', () => {
    const out = renderJournalDrafts(
      input({
        target: 'xero',
        accountMapping: MAPPING,
        entries: [
          { externalRef: 'BILL-9', counterparty: 'Vendor', direction: 'payable', grossFiat: '1210.00', vatRate: 21, currency: 'EUR', date: '2026-06-20' },
        ],
      }),
    );
    const csv = text(out.file);
    expect(csv.startsWith('*Narration,*Date,*AccountCode,*Description,Debit,Credit,Currency\n')).toBe(true);
    // asset credited gross; payable + input VAT debited net + vat. Narration carries `#N`.
    expect(csv).toContain('#1 BILL-9 — Vendor,2026-06-20,1010,BILL-9 — Vendor,0.00,1210.00,EUR');
    expect(csv).toContain('#1 BILL-9 — Vendor,2026-06-20,2000,BILL-9 — Vendor,1000.00,0.00,EUR');
    expect(csv).toContain('#1 BILL-9 — Vendor,2026-06-20,1300,BILL-9 — Vendor,210.00,0.00,EUR');
    expect(out.file.name).toBe('journal_draft_xero_2026-06_DRAFT.csv');
    const totals = columnTotals(csv, 'xero').get('EUR')!;
    expect(totals.debit.toFixed(2)).toBe(totals.credit.toFixed(2));
  });

  it('gives two same-ref/counterparty/date legs distinct Xero journal identity (#N)', () => {
    // Xero merges rows sharing a narration; without the `#N` prefix a partially-matched
    // invoice's two same-day legs would collapse into one journal (unlike QBO). The prefix
    // keeps each journal distinct on both targets.
    const out = renderJournalDrafts(
      input({
        target: 'xero',
        accountMapping: MAPPING,
        entries: [
          { externalRef: 'DUP', counterparty: 'Same', direction: 'receivable', grossFiat: '100.00', vatRate: null, currency: 'EUR', date: '2026-06-07' },
          { externalRef: 'DUP', counterparty: 'Same', direction: 'receivable', grossFiat: '200.00', vatRate: null, currency: 'EUR', date: '2026-06-07' },
        ],
      }),
    );
    const csv = text(out.file);
    expect(csv).toContain('#1 DUP — Same,2026-06-07,');
    expect(csv).toContain('#2 DUP — Same,2026-06-07,');
  });

  it('emits a 2-line entry (no VAT category) when the record carries no rate', () => {
    const out = renderJournalDrafts(
      input({
        accountMapping: MAPPING,
        entries: [
          { externalRef: 'INV-2', counterparty: 'NoVat', direction: 'receivable', grossFiat: '500.00', vatRate: null, currency: 'USD', date: '2026-06-10' },
        ],
      }),
    );
    expect(out.lines).toBe(2);
    expect(out.unmappedCategories).not.toContain('vat_output');
    expect(text(out.file)).toContain('1,2026-06-10,1010,500.00,0.00,INV-2 — NoVat,USD');
    expect(text(out.file)).toContain('1,2026-06-10,1100,0.00,500.00,INV-2 — NoVat,USD');
  });

  it('balances each currency independently in one file', () => {
    const out = renderJournalDrafts(
      input({
        accountMapping: MAPPING,
        entries: [
          { externalRef: 'A', counterparty: 'X', direction: 'receivable', grossFiat: '100.00', vatRate: null, currency: 'EUR', date: '2026-06-01' },
          { externalRef: 'B', counterparty: 'Y', direction: 'receivable', grossFiat: '250.00', vatRate: null, currency: 'USD', date: '2026-06-02' },
        ],
      }),
    );
    const totals = columnTotals(text(out.file), 'qbo');
    for (const [, t] of totals) expect(t.debit.toFixed(2)).toBe(t.credit.toFixed(2));
    expect([...totals.keys()].sort()).toEqual(['EUR', 'USD']);
    expect(out.roundingResidues.map((r) => r.currency).sort()).toEqual(['EUR', 'USD']);
  });

  it('reports categories present but not in account_mapping and falls back to default labels', () => {
    const out = renderJournalDrafts(
      input({
        // only the asset account is mapped; receivable + VAT are left unmapped
        accountMapping: { crypto_asset: '1010' },
        entries: [
          { externalRef: 'INV-3', counterparty: 'Z', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' },
        ],
      }),
    );
    expect(out.unmappedCategories).toEqual(['accounts_receivable', 'vat_output']);
    expect(text(out.file)).toContain('Accounts Receivable');
    expect(text(out.file)).toContain('VAT Output');
    // the mapped one is NOT reported and uses its code
    expect(out.unmappedCategories).not.toContain('crypto_asset');
    expect(text(out.file)).toContain(',1010,');
  });

  it('neutralizes a formula-injection payload leading a cell (CWE-1236)', () => {
    const out = renderJournalDrafts(
      input({
        accountMapping: MAPPING,
        entries: [
          { externalRef: '+SUM(99)', counterparty: '', direction: 'receivable', grossFiat: '10.00', vatRate: null, currency: 'USD', date: '2026-06-05' },
        ],
      }),
    );
    expect(text(out.file)).toContain("'+SUM(99)");
  });

  it('produces a byte-deterministic file + a self-describing manifest', () => {
    const build = (): JournalManifest =>
      renderJournalDrafts(
        input({ accountMapping: MAPPING, entries: [{ externalRef: 'INV-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' }] }),
      ).manifest;
    const a = renderJournalDrafts(input({ accountMapping: MAPPING, entries: [{ externalRef: 'INV-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' }] }));
    const b = renderJournalDrafts(input({ accountMapping: MAPPING, entries: [{ externalRef: 'INV-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' }] }));
    expect(a.file.sha256).toBe(b.file.sha256);
    const m = build();
    expect(m.kind).toBe('journal_qbo');
    expect(m.draft).toBe(true);
    expect(m.lines).toBe(3);
    expect(m.file.sha256).toBe(a.file.sha256);
    expect(m.price_refs).toEqual([]);
  });

  it('throws on a negative gross amount instead of emitting a negative debit/credit', () => {
    expect(() =>
      renderJournalDrafts(
        input({
          accountMapping: MAPPING,
          entries: [
            { externalRef: 'CR-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '-100.00', vatRate: null, currency: 'EUR', date: '2026-06-15' },
          ],
        }),
      ),
    ).toThrow(/CR-1/);
  });

  it('skips an effectively-zero (negative-rounds-to-zero) gross instead of throwing', () => {
    // roundHalfUp('-0.001', 2) === '-0.00', and isNegative('-0.00') is true — isZero
    // is checked first (V is tested for zero before it is tested for negative), so
    // this is skipped like any other zero-valued entry, not thrown on.
    const out = renderJournalDrafts(
      input({
        accountMapping: MAPPING,
        entries: [
          { externalRef: 'ZERO-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '-0.001', vatRate: null, currency: 'EUR', date: '2026-06-15' },
        ],
      }),
    );
    expect(out.lines).toBe(0);
  });

  it('has no `rounding` category: an unmapped/unknown mapping key is accepted and silently unused', () => {
    // `rounding` used to be a documented-but-dead category. It is no longer part of
    // JournalCategory, and account_mapping is an unconstrained Record<string, string>
    // at the schema level, so an unknown key here is simply never looked up — it can
    // never appear in `unmapped_categories` (there is no line that could produce it).
    const out = renderJournalDrafts(
      input({
        accountMapping: { ...MAPPING, rounding: '9999', totally_unknown_key: '0000' },
        entries: [
          { externalRef: 'INV-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' },
        ],
      }),
    );
    expect(out.unmappedCategories).toEqual([]);
    expect(out.unmappedCategories).not.toContain('rounding');
  });

  describe('filenames', () => {
    it('is byte-identical across repeat renders of the same period', () => {
      const build = (): string =>
        renderJournalDrafts(
          input({ accountMapping: MAPPING, entries: [{ externalRef: 'INV-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' }] }),
        ).file.name;
      expect(build()).toBe(build());
    });

    it('differs between two different periods', () => {
      const nameFor = (period: JournalDraftsInput['period']): string =>
        renderJournalDrafts(
          input({ period, accountMapping: MAPPING, entries: [{ externalRef: 'INV-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' }] }),
        ).file.name;
      const june = nameFor({ start: '2026-06-01', end: '2026-06-30' });
      const july = nameFor({ start: '2026-07-01', end: '2026-07-31' });
      expect(june).not.toBe(july);
    });

    it('collapses a full calendar month to `YYYY-MM`, and spells out any other period as `<start>_<end>`', () => {
      const nameFor = (period: JournalDraftsInput['period']): string =>
        renderJournalDrafts(
          input({ period, accountMapping: MAPPING, entries: [{ externalRef: 'INV-1', counterparty: 'ACME', direction: 'receivable', grossFiat: '1000.00', vatRate: 21, currency: 'EUR', date: '2026-06-15' }] }),
        ).file.name;
      expect(nameFor({ start: '2026-06-01', end: '2026-06-30' })).toBe('journal_draft_qbo_2026-06_DRAFT.csv');
      expect(nameFor({ start: '2026-06-05', end: '2026-06-20' })).toBe('journal_draft_qbo_2026-06-05_2026-06-20_DRAFT.csv');
    });
  });
});

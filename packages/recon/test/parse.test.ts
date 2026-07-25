import { describe, expect, it } from 'vitest';

import { parseInvoiceCsv } from '../src/import/parse.js';

const CSV = [
  'invoice,customer,amount,currency,issued_on,due_on,vat_rate',
  'INV-001,Acme GmbH,1000.00,EUR,2026-06-01,2026-06-30,21.0',
  'INV-002,Beta LLC,500.50,USD,2026-06-05,2026-07-05,0',
].join('\n');

describe('parseInvoiceCsv — auto-detected columns', () => {
  it('maps headers to canonical fields and normalizes each row', () => {
    const { drafts, errors } = parseInvoiceCsv(CSV);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      kind: 'invoice',
      source: 'csv',
      direction: 'receivable',
      externalRef: 'INV-001',
      counterpartyName: 'Acme GmbH',
      amount: '1000.00',
      currency: 'EUR',
      issuedOn: '2026-06-01',
      dueOn: '2026-06-30',
      vatRate: '21.0',
    });
    // the raw row is retained for audit
    expect(drafts[0]?.payload).toMatchObject({ invoice: 'INV-001', amount: '1000.00' });
  });

  it('uppercases the currency and defaults it when the column is absent', () => {
    const csv = 'invoice,customer,amount\nINV-9,Foo,10.00';
    const { drafts, errors } = parseInvoiceCsv(csv, { defaults: { currency: 'eur' } });
    expect(errors).toEqual([]);
    expect(drafts[0]?.currency).toBe('EUR');
  });
});

describe('parseInvoiceCsv — mapping override and defaults', () => {
  it('honors an explicit column → field mapping over auto-detection', () => {
    const csv = 'ref_no,who,gross\nR-1,Client X,42.00';
    const { drafts, errors } = parseInvoiceCsv(csv, {
      mapping: { ref_no: 'external_ref', who: 'counterparty_name', gross: 'amount' },
      defaults: { currency: 'USD' },
    });
    expect(errors).toEqual([]);
    expect(drafts[0]).toMatchObject({ externalRef: 'R-1', counterpartyName: 'Client X', amount: '42.00', currency: 'USD' });
  });

  it('applies a default direction and rejects an invalid per-row direction', () => {
    const csv = 'invoice,amount,currency,direction\nINV-1,10.00,EUR,payable\nINV-2,20.00,EUR,sideways';
    const { drafts, errors } = parseInvoiceCsv(csv, { defaults: { direction: 'receivable' } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ externalRef: 'INV-1', direction: 'payable' });
    expect(errors).toEqual([{ row: 2, code: 'INVALID_DIRECTION', message: expect.stringContaining('sideways') }]);
  });
});

describe('parseInvoiceCsv — validation and honest row failures', () => {
  it('skips a structurally broken row and a negative amount, reporting each', () => {
    const csv = 'invoice,amount,currency\nINV-1,1,234.56,EUR\nINV-2,-5,EUR\nINV-3,99.99,EUR';
    // "1,234.56" unquoted splits into extra fields (a thousands separator is not
    // supported) → a field-count mismatch; "-5" is a negative amount.
    const { drafts, errors } = parseInvoiceCsv(csv);
    expect(drafts.map((d) => d.externalRef)).toEqual(['INV-3']);
    expect(errors.map((e) => e.code)).toEqual(['WRONG_FIELD_COUNT', 'INVALID_AMOUNT']);
    expect(errors.map((e) => e.row)).toEqual([1, 2]);
  });

  it('reports a file-level error when a required column is absent', () => {
    const csv = 'customer,amount,currency\nAcme,10.00,EUR';
    const { drafts, errors } = parseInvoiceCsv(csv);
    expect(drafts).toEqual([]);
    expect(errors).toEqual([{ row: 0, code: 'NO_EXTERNAL_REF_COLUMN', message: expect.any(String) }]);
  });

  it('reports a file-level error on empty content', () => {
    const { drafts, errors } = parseInvoiceCsv('   ');
    expect(drafts).toEqual([]);
    expect(errors[0]?.code).toBe('EMPTY');
  });

  it('rejects a malformed issued_on date', () => {
    const csv = 'invoice,amount,currency,issued_on\nINV-1,10.00,EUR,06/01/2026';
    const { drafts, errors } = parseInvoiceCsv(csv);
    expect(drafts).toEqual([]);
    expect(errors[0]).toMatchObject({ row: 1, code: 'INVALID_DATE' });
  });
});

describe('parseInvoiceCsv — hostile input stays raw here', () => {
  it('keeps a formula-lead counterparty name verbatim (sanitization is at the response edge)', () => {
    const csv = 'invoice,customer,amount,currency\nINV-1,=SUM(A1:A9),10.00,EUR';
    const { drafts } = parseInvoiceCsv(csv);
    expect(drafts[0]?.counterpartyName).toBe('=SUM(A1:A9)');
    expect(drafts[0]?.payload.customer).toBe('=SUM(A1:A9)');
  });

  it('parses quoted fields containing the delimiter', () => {
    const csv = 'invoice,customer,amount,currency\nINV-1,"Acme, Inc.",10.00,EUR';
    const { drafts } = parseInvoiceCsv(csv);
    expect(drafts[0]?.counterpartyName).toBe('Acme, Inc.');
  });

  it('lowercases a checksummed expected_address', () => {
    const addr = '0xAbC0000000000000000000000000000000000123';
    const csv = `invoice,amount,currency,wallet\nINV-1,10.00,EUR,${addr}`;
    const { drafts } = parseInvoiceCsv(csv);
    expect(drafts[0]?.expectedAddress).toBe(addr.toLowerCase());
  });
});

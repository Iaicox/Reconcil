/**
 * Deterministic invoice-CSV parser (Face B import, contract §6.4). Pure: a CSV
 * string in, `{ drafts, errors }` out — no I/O, so it is hermetically testable
 * and the tool handler owns reading `file_path`. Row failures are collected and
 * reported, never thrown (the row is skipped, first fault per row wins). Amounts
 * stay decimal strings (ADR-004); counterparty names stay raw (sanitized only at
 * the response edge, P7/ADR-011). Columns are auto-detected from the header and
 * can be overridden per the `mapping` input.
 */
import { isoDateString, nonNegativeDecimalString } from '@reconcil/core';
import { parse } from 'csv-parse/sync';

import type {
  CanonicalField, Direction, ExternalRecordDraft, ImportRowError, ParseOptions, ParseResult,
} from './types.js';

export type { ExternalRecordDraft, ParseOptions, ParseResult };

/** Header → canonical field aliases. Disjoint by construction: a header matches
 *  at most one field, so detection is order-independent and deterministic. */
const FIELD_ALIASES: Record<CanonicalField, readonly string[]> = {
  external_ref: ['externalref', 'invoice', 'invoiceno', 'invoicenumber', 'invoicenr', 'invoiceid', 'number', 'no', 'ref', 'reference'],
  counterparty_name: ['counterparty', 'counterpartyname', 'client', 'clientname', 'customer', 'customername', 'name', 'payer', 'company', 'debtor'],
  amount: ['amount', 'total', 'gross', 'grossamount', 'amountgross', 'amountdue', 'totalamount', 'totaldue'],
  currency: ['currency', 'ccy', 'curr'],
  vat_rate: ['vatrate', 'vatpercent', 'taxrate', 'taxpercent'],
  vat_amount: ['vatamount', 'taxamount', 'vatvalue'],
  issued_on: ['issuedon', 'issuedate', 'issued', 'date', 'invoicedate'],
  due_on: ['dueon', 'duedate', 'due'],
  direction: ['direction', 'type'],
  expected_address: ['expectedaddress', 'wallet', 'walletaddress', 'address', 'payto', 'payaddress'],
};

const CANONICAL_FIELDS = Object.keys(FIELD_ALIASES) as CanonicalField[];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const normalizeHeader = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve `canonical field → original header` from the header row + overrides. */
function resolveColumns(headers: string[], mapping?: Record<string, string>): Partial<Record<CanonicalField, string>> {
  const column: Partial<Record<CanonicalField, string>> = {};
  for (const header of headers) {
    const norm = normalizeHeader(header);
    for (const field of CANONICAL_FIELDS) {
      if (column[field] === undefined && FIELD_ALIASES[field].includes(norm)) {
        column[field] = header;
        break; // a header maps to one field; keep the first column that claims it
      }
    }
  }
  // Explicit mapping (CSV column → canonical field) overrides auto-detection.
  for (const [csvColumn, target] of Object.entries(mapping ?? {})) {
    if ((CANONICAL_FIELDS as string[]).includes(target)) column[target as CanonicalField] = csvColumn;
  }
  return column;
}

function isDecimal(v: string): boolean {
  return nonNegativeDecimalString.safeParse(v).success;
}

export function parseInvoiceCsv(content: string, opts: ParseOptions = {}): ParseResult {
  if (content.trim() === '') return { drafts: [], errors: [{ row: 0, code: 'EMPTY', message: 'CSV is empty' }] };

  // Array mode (no `columns`): keeps per-row control so one ragged row is a row
  // error, not a whole-file throw. `relax_column_count` lets us count fields and
  // report the mismatch ourselves.
  const rows = parse(content, {
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as string[][];

  if (rows.length === 0) return { drafts: [], errors: [{ row: 0, code: 'EMPTY', message: 'CSV has no header row' }] };

  const headers = rows[0]!;
  const column = resolveColumns(headers, opts.mapping);
  const defaults = opts.defaults ?? {};

  // File-level: required columns must be resolvable, else every row would fail.
  const fileErrors: ImportRowError[] = [];
  if (column.external_ref === undefined) fileErrors.push({ row: 0, code: 'NO_EXTERNAL_REF_COLUMN', message: 'no column maps to external_ref' });
  if (column.amount === undefined) fileErrors.push({ row: 0, code: 'NO_AMOUNT_COLUMN', message: 'no column maps to amount' });
  if (column.currency === undefined && defaults.currency === undefined) {
    fileErrors.push({ row: 0, code: 'NO_CURRENCY_COLUMN', message: 'no column maps to currency and no default currency was given' });
  }
  if (fileErrors.length > 0) return { drafts: [], errors: fileErrors };

  const headerIndex = new Map(headers.map((h, i) => [h, i] as const));
  const drafts: ExternalRecordDraft[] = [];
  const errors: ImportRowError[] = [];

  for (let i = 1; i < rows.length; i += 1) {
    const rowNo = i;
    const fields = rows[i]!;
    if (fields.length !== headers.length) {
      errors.push({ row: rowNo, code: 'WRONG_FIELD_COUNT', message: `expected ${String(headers.length)} fields, got ${String(fields.length)}` });
      continue;
    }

    const rawRow: Record<string, string> = {};
    for (const h of headers) rawRow[h] = fields[headerIndex.get(h)!] ?? '';

    const cell = (field: CanonicalField): string | undefined => {
      const col = column[field];
      if (col === undefined) return undefined;
      const v = (rawRow[col] ?? '').trim();
      return v === '' ? undefined : v;
    };

    const externalRef = cell('external_ref');
    if (externalRef === undefined) { errors.push({ row: rowNo, code: 'MISSING_FIELD', message: 'external_ref is empty' }); continue; }

    const amount = cell('amount');
    if (amount === undefined) { errors.push({ row: rowNo, code: 'MISSING_FIELD', message: 'amount is empty' }); continue; }
    if (!isDecimal(amount)) { errors.push({ row: rowNo, code: 'INVALID_AMOUNT', message: `amount is not a non-negative decimal: ${amount}` }); continue; }

    const currencyRaw = cell('currency') ?? defaults.currency;
    if (currencyRaw === undefined) { errors.push({ row: rowNo, code: 'MISSING_CURRENCY', message: 'currency is empty and no default given' }); continue; }
    const currency = currencyRaw.toUpperCase();

    const directionRaw = cell('direction');
    let direction: Direction;
    if (directionRaw !== undefined) {
      if (directionRaw !== 'receivable' && directionRaw !== 'payable') {
        errors.push({ row: rowNo, code: 'INVALID_DIRECTION', message: `direction must be receivable|payable, got ${directionRaw}` });
        continue;
      }
      direction = directionRaw;
    } else {
      direction = defaults.direction ?? 'receivable';
    }

    const issuedOn = cell('issued_on');
    if (issuedOn !== undefined && !isoDateString.safeParse(issuedOn).success) {
      errors.push({ row: rowNo, code: 'INVALID_DATE', message: `issued_on is not an ISO date: ${issuedOn}` });
      continue;
    }
    const dueOn = cell('due_on');
    if (dueOn !== undefined && !isoDateString.safeParse(dueOn).success) {
      errors.push({ row: rowNo, code: 'INVALID_DATE', message: `due_on is not an ISO date: ${dueOn}` });
      continue;
    }

    const vatRate = cell('vat_rate') ?? defaults.vatRate;
    if (vatRate !== undefined && !isDecimal(vatRate)) {
      errors.push({ row: rowNo, code: 'INVALID_VAT', message: `vat_rate is not a non-negative decimal: ${vatRate}` });
      continue;
    }
    const vatAmount = cell('vat_amount');
    if (vatAmount !== undefined && !isDecimal(vatAmount)) {
      errors.push({ row: rowNo, code: 'INVALID_VAT', message: `vat_amount is not a non-negative decimal: ${vatAmount}` });
      continue;
    }

    const expectedRaw = cell('expected_address');
    if (expectedRaw !== undefined && !ADDRESS_RE.test(expectedRaw)) {
      errors.push({ row: rowNo, code: 'INVALID_ADDRESS', message: `expected_address is not a 0x-address: ${expectedRaw}` });
      continue;
    }

    drafts.push({
      kind: 'invoice',
      direction,
      source: 'csv',
      externalRef,
      counterpartyName: cell('counterparty_name') ?? null,
      amount,
      currency,
      vatRate: vatRate ?? null,
      vatAmount: vatAmount ?? null,
      issuedOn: issuedOn ?? null,
      dueOn: dueOn ?? null,
      expectedAddress: expectedRaw === undefined ? null : expectedRaw.toLowerCase(),
      payload: rawRow,
    });
  }

  return { drafts, errors };
}

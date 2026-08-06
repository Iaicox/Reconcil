/**
 * Face A journal draft (ADR-004, ADR-010, P8). No reconciliation engine exists
 * yet (that is Face B), so this is a MINIMAL, clearly-labeled DRAFT derived from
 * ledger flows alone: each token's net valued movement parks against a Suspense
 * account pending classification, gas is a Network Fees expense. Every figure is
 * rounded half-up to 2dp HERE (the only rounding site), and `balanceJournal`
 * guarantees debits == credits per currency by appending a Rounding residue line
 * (invariant #8). The Face B QBO/Xero export replaces this with account-mapped,
 * recon-backed journals.
 */
import { absDecimal, isNegative, isZero, roundHalfUp, subtract, sumDecimals } from './decimal.js';
import type { Currency, JournalInput } from './types.js';

export interface JournalLine {
  date: string;
  account: string;
  description: string;
  debit: string; // 2dp decimal string; '0.00' when this line is a credit
  credit: string; // 2dp decimal string; '0.00' when this line is a debit
  currency: string;
}

export interface JournalResult {
  lines: JournalLine[];
  residue: string; // debit − credit after the rounding line; always '0.00'
}

const ACCOUNT_ASSETS = 'Crypto Assets';
const ACCOUNT_SUSPENSE = 'Suspense — unclassified';
const ACCOUNT_GAS = 'Network Fees (gas)';
const ACCOUNT_ROUNDING = 'Rounding';
const ZERO = '0.00';

function debitLine(date: string, account: string, description: string, amount: string, currency: string): JournalLine {
  return { date, account, description, debit: amount, credit: ZERO, currency };
}

function creditLine(date: string, account: string, description: string, amount: string, currency: string): JournalLine {
  return { date, account, description, debit: ZERO, credit: amount, currency };
}

/**
 * Append a single Rounding line so total debits equal total credits exactly.
 * Lines are expected to be 2dp already, so any residue is a whole number of
 * cents (≤ 0.01 × line count, invariant #8). Exported for property testing.
 */
export function balanceJournal(lines: JournalLine[], currency: string, date: string): JournalResult {
  const residue = roundHalfUp(
    subtract(sumDecimals(lines.map((l) => l.debit)), sumDecimals(lines.map((l) => l.credit))),
    2,
  );
  const out = [...lines];
  if (!isZero(residue)) {
    const magnitude = roundHalfUp(absDecimal(residue), 2);
    // residue > 0 ⇒ debits exceed credits ⇒ balance with a credit, and vice versa.
    out.push(
      isNegative(residue)
        ? debitLine(date, ACCOUNT_ROUNDING, 'Rounding residue (DRAFT)', magnitude, currency)
        : creditLine(date, ACCOUNT_ROUNDING, 'Rounding residue (DRAFT)', magnitude, currency),
    );
  }
  const finalResidue = roundHalfUp(
    subtract(sumDecimals(out.map((l) => l.debit)), sumDecimals(out.map((l) => l.credit))),
    2,
  );
  return { lines: out, residue: finalResidue };
}

/**
 * Movements go through `absDecimal` + an `isNegative` branch to derive debit/credit
 * *direction* from the sign of the net flow. Gas has no such direction (it is always
 * an outflow), so a negative `gasFiat` throws instead: credit notes/reversals are not
 * modelled yet; when they are, they must flip the entry's sides, not emit a negative
 * amount.
 */
export function buildJournalDraft(input: JournalInput, currency: Currency, date: string): JournalResult {
  const lines: JournalLine[] = [];

  for (const m of input.movements) {
    const net = roundHalfUp(m.netFiat, 2);
    if (isZero(net)) continue;
    const magnitude = roundHalfUp(absDecimal(net), 2);
    const description = `Net ${m.tokenSymbol} movement (DRAFT)`;
    if (isNegative(net)) {
      // Net outflow: assets down, offset to Suspense.
      lines.push(creditLine(date, ACCOUNT_ASSETS, description, magnitude, currency));
      lines.push(debitLine(date, ACCOUNT_SUSPENSE, description, magnitude, currency));
    } else {
      // Net inflow: assets up, offset to Suspense.
      lines.push(debitLine(date, ACCOUNT_ASSETS, description, magnitude, currency));
      lines.push(creditLine(date, ACCOUNT_SUSPENSE, description, magnitude, currency));
    }
  }

  if (input.gasFiat !== undefined) {
    const gas = roundHalfUp(input.gasFiat, 2);
    // isZero is checked first, matching entryLines: `roundHalfUp` preserves the sign
    // of a negative value that rounds to zero (e.g. '-0.001' -> '-0.00', and
    // isNegative('-0.00') is true), so an effectively-zero gas must be skipped before
    // the negative check runs, not thrown on. Gas has no direction to sign-flip (see
    // the docstring above), so a genuinely negative gas throws.
    if (!isZero(gas)) {
      if (isNegative(gas)) {
        throw new Error(`journal: gasFiat ${gas} is negative; credit notes/reversals are not modelled yet — they must flip the entry's sides, not emit a negative amount`);
      }
      lines.push(debitLine(date, ACCOUNT_GAS, 'Gas fees (DRAFT)', gas, currency));
      lines.push(creditLine(date, ACCOUNT_ASSETS, 'Gas fees (DRAFT)', gas, currency));
    }
  }

  return balanceJournal(lines, currency, date);
}

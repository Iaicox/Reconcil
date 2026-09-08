/**
 * Exact decimal arithmetic for fiat valuation (ADR-004, ADR-007). Fiat values
 * (price, fx, fiat_value) are non-integer and division enters here — the one
 * place a decimal library is allowed. Configured for **full precision
 * internally; round only at export**: 40 significant digits, half-up. Canonical
 * amounts on chain stay `bigint` base units (core/money.ts) — never a float.
 */
import { Decimal } from 'decimal.js';

import type { DecimalString } from '@reconcil/core';

// A private clone so global Decimal config elsewhere can't perturb money math.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Fixed-point, unrounded, no exponent — a canonical `DecimalString`. */
function toStr(d: Decimal): DecimalString {
  return d.toFixed() as DecimalString;
}

export function multiply(a: string, b: string): DecimalString {
  return toStr(new D(a).mul(b));
}

export function divide(a: string, b: string): DecimalString {
  return toStr(new D(a).div(b));
}

/** Exact sum of decimal strings (fiat totals). Empty → '0'. */
export function sumDecimals(values: string[]): DecimalString {
  return toStr(values.reduce((acc, v) => acc.plus(v), new D(0)));
}

/** Round to `dp` decimal places, half-up — an export-boundary operation only. */
export function roundHalfUp(value: string, dp: number): DecimalString {
  return new D(value).toFixed(dp) as DecimalString;
}

/**
 * A JSON number's source text, exactly as it appeared in the payload. Anything else —
 * a symbol, a date, an empty string — must not be mistaken for a quote, so the grammar
 * is JSON's own and nothing looser.
 */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Canonicalize a provider's JSON price into a non-exponential decimal string (the value
 * we then store and pin).
 *
 * Accepts either the parsed `number` or the **source text** of the JSON number. The text
 * is the exact form and the one to prefer: by the time a `number` gets here, `JSON.parse`
 * has already rounded the provider's quote to float precision, so the stored snapshot can
 * differ from what was actually quoted in its last digits. `realFetchJson` now hands over
 * the source text (transport.ts), which closes that crossing; the `number` branch remains
 * for fixtures recorded before it, where the text is already gone.
 *
 * Non-finite, non-numeric, or a string that is not a JSON number → null.
 */
export function numberToDecimalString(n: unknown): DecimalString | null {
  if (typeof n === 'string') {
    return JSON_NUMBER.test(n) ? (new D(n).toFixed() as DecimalString) : null;
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return new D(String(n)).toFixed() as DecimalString;
}

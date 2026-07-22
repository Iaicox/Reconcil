/**
 * Exact decimal arithmetic for fiat valuation (ADR-004, ADR-007). Fiat values
 * (price, fx, fiat_value) are non-integer and division enters here — the one
 * place a decimal library is allowed. Configured for **full precision
 * internally; round only at export**: 40 significant digits, half-up. Canonical
 * amounts on chain stay `bigint` base units (core/money.ts) — never a float.
 */
import { Decimal } from 'decimal.js';

import type { DecimalString } from '@pet-crypto/core';

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
 * Canonicalize a provider's JSON price number into a non-exponential decimal
 * string (the value we then store and pin). A JSON number is a float, so this is
 * the one lossy crossing — but the *stored* snapshot string is what P5 pins and
 * reproduces; providers quote display-precision. Non-finite/non-number → null.
 */
export function numberToDecimalString(n: unknown): DecimalString | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return new D(String(n)).toFixed() as DecimalString;
}

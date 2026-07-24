/**
 * Export-boundary decimal arithmetic (ADR-004). This package is the ONLY place
 * fiat figures are rounded — full precision is kept upstream (pricing) and reduced
 * to presentation precision (2dp, half-up) exactly once, here. A private Decimal
 * clone keeps global config elsewhere from perturbing money math.
 */
import { Decimal } from 'decimal.js';

import type { DecimalString } from '@pet-crypto/core';

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Round to `dp` decimal places, half-up — the export-boundary rounding. */
export function roundHalfUp(value: string, dp: number): DecimalString {
  return new D(value).toFixed(dp) as DecimalString;
}

/** Exact sum of decimal strings (no rounding). Empty → '0'. */
export function sumDecimals(values: string[]): DecimalString {
  return values.reduce((acc, v) => acc.plus(v), new D(0)).toFixed() as DecimalString;
}

/** Exact `a − b`, unrounded. */
export function subtract(a: string, b: string): DecimalString {
  return new D(a).minus(b).toFixed() as DecimalString;
}

export function isZero(value: string): boolean {
  return new D(value).isZero();
}

export function isNegative(value: string): boolean {
  return new D(value).isNegative();
}

/** Absolute value, unrounded. */
export function absDecimal(value: string): DecimalString {
  return new D(value).abs().toFixed() as DecimalString;
}

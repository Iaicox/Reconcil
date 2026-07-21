/**
 * Money math (ADR-004, P1). Canonical amounts are base units (uint256) held as
 * `bigint`; display/fiat values cross boundaries as decimal strings. Scaling by
 * 10^decimals is exact/terminating, so it needs no decimal library — pure
 * bigint↔string. Division/FX (fiat valuation) lives in the pricing slice.
 */
import type { Brand } from './brand.js';

/** Exact base units as on chain (uint256), never a plain `number`. */
export type RawAmount = Brand<bigint, 'RawAmount'>;

/** A display/fiat value on the wire: a canonical-minimal decimal string. */
export type DecimalString = Brand<string, 'DecimalString'>;

/**
 * Scale raw base units to a display decimal string: raw / 10^decimals, exact.
 * Signed (net flows can be negative), canonical-minimal (trailing zeros in the
 * fractional part are trimmed; a whole value carries no point). Scaling only —
 * never rounds; fixed-dp/rounding is an export-boundary concern.
 */
export function formatUnits(raw: bigint, decimals: number): DecimalString {
  if (decimals === 0) return String(raw) as DecimalString;
  const neg = raw < 0n;
  const digits = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const intPart = digits.slice(0, cut);
  const frac = digits.slice(cut).replace(/0+$/, '');
  const body = frac === '' ? intPart : `${intPart}.${frac}`;
  return (neg && body !== '0' ? `-${body}` : body) as DecimalString;
}

/**
 * Inverse of formatUnits: parse a decimal string back to base units, exact.
 * Throws if the fractional part carries more precision than `decimals` can hold.
 */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new RangeError(`not a decimal string: ${value}`);
  const [, sign, whole, frac = ''] = m;
  if (frac.length > decimals) {
    throw new RangeError(`too many fractional digits for ${decimals} decimals: ${value}`);
  }
  const scaled = BigInt(whole + frac.padEnd(decimals, '0'));
  return sign === '-' ? -scaled : scaled;
}

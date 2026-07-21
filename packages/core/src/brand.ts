declare const brand: unique symbol;

/**
 * Nominal typing helper for domain primitives (Address, TxHash, RawAmount, …).
 * Money is never a plain `number` (ADR-004); brands make raw/display and
 * unit/currency mix-ups a compile error. Lives in its own module so value
 * modules (money) can brand without importing the package barrel (no cycle).
 */
export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

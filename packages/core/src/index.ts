/**
 * Shared kernel: domain types, Zod schemas, money math (bigint + branded
 * types), chain config registry, sanitizer. No I/O by design (00-overview §3).
 */

declare const brand: unique symbol;

/**
 * Nominal typing helper for domain primitives (Address, TxHash, RawAmount, …).
 * Money is never a plain `number` (ADR-004); brands make raw/display and
 * unit/currency mix-ups a compile error.
 */
export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export {
  chains,
  chainById,
  type ChainConfig,
  type ProviderConfig,
  type FeeStrategy,
} from './chains.config.js';

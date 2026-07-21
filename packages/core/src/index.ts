/**
 * Shared kernel: domain types, Zod schemas, money math (bigint + branded
 * types), chain config registry, sanitizer, structured stdout logger. No
 * network/DB/filesystem I/O by design (00-overview §3).
 */

export type { Brand } from './brand.js';

export {
  chains,
  chainById,
  type ChainConfig,
  type ProviderConfig,
  type FeeStrategy,
} from './chains.config.js';

export { createLogger, serializeError, type Logger } from './logger.js';

export { formatUnits, parseUnits, type RawAmount, type DecimalString } from './money.js';

/**
 * Shared kernel: domain types, Zod schemas, money math (bigint + branded
 * types), chain config registry, sanitizer, structured stdout logger. No
 * network/DB/filesystem I/O by design (00-overview §3).
 */

export type { Brand } from './brand.js';

export {
  chains,
  chainById,
  ANCHOR_SUGGEST_TX_THRESHOLD,
  type ChainConfig,
  type ProviderConfig,
  type FeeStrategy,
} from './chains.config.js';

export { backfillJobId, anchorJobId, probeJobId } from './jobs.js';

export { createLogger, serializeError, type Logger } from './logger.js';

export { formatUnits, parseUnits, type RawAmount, type DecimalString } from './money.js';

export { sanitize, type Sanitized } from './sanitizer.js';

export * from './schemas.js';

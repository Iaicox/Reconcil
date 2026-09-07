/**
 * Worker env (ADR-008 / docker-compose). DATABASE_URL and REDIS_URL are injected
 * by compose; ETHERSCAN_API_KEY and BASE_RPC_URL are worker-only provider config.
 */
import { z } from 'zod';

/**
 * A genuinely optional env var. `.optional()` alone only covers an ABSENT variable, but a
 * compose `env_file` line like `ETHERSCAN_API_KEY=` sets it to the EMPTY STRING — present,
 * and therefore rejected by `.min(1)`. That is exactly what `.env.example` ships for the
 * three provider keys it documents as optional, so the quickstart's own
 * `cp .env.example .env && docker compose up` crashed the worker at boot with a ZodError
 * before it could run migrations. Normalising empty to undefined makes "unset" and "set to
 * nothing" mean the same thing, which is what every caller already assumes.
 */
const optionalEnv = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ETHERSCAN_API_KEY: optionalEnv,
  BASE_RPC_URL: optionalEnv,
  COINGECKO_API_KEY: optionalEnv, // pricing secondary source; DefiLlama/ECB keyless
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return schema.parse(env);
}

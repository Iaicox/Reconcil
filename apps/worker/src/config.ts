/**
 * Worker env (ADR-008 / docker-compose). DATABASE_URL and REDIS_URL are injected
 * by compose; ETHERSCAN_API_KEY and BASE_RPC_URL are worker-only provider config.
 */
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  BASE_RPC_URL: z.string().min(1).optional(),
  COINGECKO_API_KEY: z.string().min(1).optional(), // pricing secondary source; DefiLlama/ECB keyless
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return schema.parse(env);
}

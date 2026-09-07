/**
 * Provider bundle wiring, split out of main.ts for testability (H15 minor).
 * `cfg = loadConfig()` validates ETHERSCAN_API_KEY/BASE_RPC_URL/COINGECKO_API_KEY,
 * but the chain and price bundle factories used to receive `env: process.env`
 * directly — the schema never actually gated what they read, so a typo'd or
 * unset key only surfaced as a provider 401/RPC failure deep inside a job, not
 * at boot. Building the env record FROM cfg makes loadConfig() load-bearing.
 */
import { buildProviderBundle, type FetchJson, type ProviderBundle } from '@reconcil/ingestion';
import { buildPriceProviderBundle, type PriceBundle } from '@reconcil/pricing';

import type { WorkerConfig } from './config.js';

// The union of keys any provider factory reads: chains.config.ts's
// apiKeyEnv/rpcUrlEnv (ETHERSCAN_API_KEY, BASE_RPC_URL) for the chain bundle,
// COINGECKO_API_KEY for the price bundle. Each factory only reads its own
// subset by name; the extra key in the other's record is inert.
export function providerEnvFrom(cfg: WorkerConfig): Record<string, string | undefined> {
  return {
    ETHERSCAN_API_KEY: cfg.ETHERSCAN_API_KEY,
    BASE_RPC_URL: cfg.BASE_RPC_URL,
    COINGECKO_API_KEY: cfg.COINGECKO_API_KEY,
  };
}

export function buildChainBundle(
  cfg: WorkerConfig,
  chainId: number,
  fetchJson: FetchJson,
  build: typeof buildProviderBundle = buildProviderBundle,
): ProviderBundle {
  return build({ chainId, env: providerEnvFrom(cfg), fetchJson });
}

export function buildPriceBundle(
  cfg: WorkerConfig,
  fetchJson: FetchJson,
  build: typeof buildPriceProviderBundle = buildPriceProviderBundle,
): PriceBundle {
  return build({ env: providerEnvFrom(cfg), fetchJson });
}

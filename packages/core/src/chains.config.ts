/**
 * Chains as configuration (ADR-009, 03-ingestion §7): adding an EVM chain is one
 * entry here, zero code changes. Fee strategy is a chain property, not a provider
 * property — OP-stack chains carry an L1 data fee (ADR-005).
 */
export type FeeStrategy = 'txlist' | 'receipts-opstack';

export interface ProviderConfig {
  readonly kind: 'etherscan-v2' | 'blockscout';
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
}

export interface ChainConfig {
  readonly chainId: number;
  readonly name: string;
  readonly native: { readonly symbol: string; readonly decimals: number };
  readonly finalityDepth: bigint;
  readonly pollIntervalSec: number;
  readonly feeStrategy: FeeStrategy;
  readonly providers: readonly ProviderConfig[];
  readonly rpcUrlEnv?: string; // public JSON-RPC endpoint env var (OP-stack receipts, 03-ingestion §7)
}

export const chains: readonly ChainConfig[] = [
  {
    chainId: 1,
    name: 'ethereum',
    native: { symbol: 'ETH', decimals: 18 },
    finalityDepth: 64n,
    pollIntervalSec: 45,
    feeStrategy: 'txlist',
    providers: [
      { kind: 'etherscan-v2', baseUrl: 'https://api.etherscan.io/v2/api', apiKeyEnv: 'ETHERSCAN_API_KEY' },
      { kind: 'blockscout', baseUrl: 'https://eth.blockscout.com/api' },
    ],
  },
  {
    chainId: 8453,
    name: 'base',
    native: { symbol: 'ETH', decimals: 18 },
    finalityDepth: 600n,
    pollIntervalSec: 30,
    feeStrategy: 'receipts-opstack',
    rpcUrlEnv: 'BASE_RPC_URL',
    providers: [
      { kind: 'etherscan-v2', baseUrl: 'https://api.etherscan.io/v2/api', apiKeyEnv: 'ETHERSCAN_API_KEY' },
      { kind: 'blockscout', baseUrl: 'https://base.blockscout.com/api' },
    ],
  },
];

export function chainById(chainId: number): ChainConfig {
  const chain = chains.find((c) => c.chainId === chainId);
  if (!chain) throw new Error(`unknown chain id ${String(chainId)}`);
  return chain;
}

/**
 * >50k probe threshold (ADR-008, open question Q5): a wallet whose provider-
 * estimated transaction count exceeds this is a "whale", and `ledger_status`
 * surfaces `suggests_anchored` so a human can re-track it in anchored mode. It is
 * a tunable guess — kept in one place so re-tuning is a one-line change.
 */
export const ANCHOR_SUGGEST_TX_THRESHOLD = 50_000;

/**
 * Config + env → providers (ADR-009). Ordered failover: etherscan-v2 primary,
 * blockscout secondary — this also routes Base indexer calls, since the etherscan
 * free tier errors on chain 8453 and the failover falls through (spec §7).
 * Receipts route to the public RPC on receipts-opstack chains, to the indexer
 * otherwise.
 */
import { chainById } from '@pet-crypto/core';
import { ProviderError, type ChainDataProvider, type FetchJson, type PageQuery, type RawReceipt } from '../types.js';
import { etherscanV2Adapter } from './etherscan-v2.js';
import { blockscoutAdapter } from './blockscout.js';
import { httpRpcCall, rpcGetReceipts, type RpcCall } from './rpc.js';

export interface ProviderBundle {
  indexer: ChainDataProvider;
  getReceipts(hashes: string[]): Promise<RawReceipt[]>;
}

export function failoverProvider(providers: ChainDataProvider[]): ChainDataProvider {
  // `served` records which provider last answered so the caller can stamp the
  // real provider onto each event row (ADR-009 audit). A processor runs one
  // fetch per ingestOnce, then reads `.kind` — no interleaving to race.
  let served = providers[0]?.kind ?? 'etherscan-v2';
  const attempt = async <T>(fn: (p: ChainDataProvider) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const p of providers) {
      try {
        const out = await fn(p);
        served = p.kind;
        return out;
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        last = err;
      }
    }
    throw last;
  };
  return {
    get kind() { return served; },
    getHead: (chainId) => attempt((p) => p.getHead(chainId)),
    getNativeTxs: (q: PageQuery) => attempt((p) => p.getNativeTxs(q)),
    getErc20Transfers: (q: PageQuery) => attempt((p) => p.getErc20Transfers(q)),
  };
}

export function buildProviderBundle(opts: {
  chainId: number;
  env: Record<string, string | undefined>;
  fetchJson: FetchJson;
  rpcCallFor?: (url: string) => RpcCall;
}): ProviderBundle {
  const chain = chainById(opts.chainId);
  const [primaryCfg, secondaryCfg] = chain.providers;
  if (!primaryCfg || !secondaryCfg) throw new Error(`chain ${String(opts.chainId)} needs two providers`);

  const etherscan = etherscanV2Adapter({
    fetchJson: opts.fetchJson,
    baseUrl: primaryCfg.baseUrl,
    apiKey: (primaryCfg.apiKeyEnv ? opts.env[primaryCfg.apiKeyEnv] : undefined) ?? '',
  });
  const blockscout = blockscoutAdapter({
    fetchJson: opts.fetchJson,
    baseUrl: secondaryCfg.baseUrl,
    chainId: opts.chainId,
  });
  const indexer = failoverProvider([etherscan, blockscout]);

  const getReceipts = async (hashes: string[]): Promise<RawReceipt[]> => {
    if (chain.feeStrategy === 'receipts-opstack') {
      const url = chain.rpcUrlEnv ? opts.env[chain.rpcUrlEnv] : undefined;
      if (!url) throw new Error(`${chain.rpcUrlEnv ?? 'rpcUrlEnv'} is required for chain ${chain.name}`);
      const rpc = (opts.rpcCallFor ?? httpRpcCall)(url);
      return rpcGetReceipts(rpc, hashes);
    }
    return etherscan.getReceipts?.(opts.chainId, hashes) ?? [];
  };

  return { indexer, getReceipts };
}

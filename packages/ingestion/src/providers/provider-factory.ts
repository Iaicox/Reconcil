/**
 * Config + env → providers (ADR-009). Ordered failover: etherscan-v2 primary,
 * blockscout secondary — this also routes Base indexer calls, since the etherscan
 * free tier errors on chain 8453 and the failover falls through (spec §7).
 * Receipts route to the public RPC on receipts-opstack chains, and to the
 * primary adapter's own receipt endpoint otherwise (not the failover indexer) —
 * receipt-level provider failover is out of scope this slice; BullMQ retry
 * covers transient receipt errors (D8).
 */
import { chainById } from '@pet-crypto/core';
import { ProviderError, type ChainDataProvider, type FetchJson, type PageQuery, type RawReceipt } from '../types.js';
import { etherscanV2Adapter } from './etherscan-v2.js';
import { blockscoutAdapter } from './blockscout.js';
import { httpRpcCall, rpcGetReceipts, type RpcCall } from './rpc.js';

/** A provider-attested balance plus the provider that served it (ADR-009 audit:
 *  the opening_balance event records this on `chain_events.provider`). */
export interface BalanceResult {
  balance: bigint;
  provider: string;
}

export interface ProviderBundle {
  indexer: ChainDataProvider;
  getReceipts(hashes: string[]): Promise<RawReceipt[]>;
  // Anchoring capabilities (ADR-008), chain bound at build time. Balance-at-block
  // routes to whichever provider serves it (etherscan is Pro-only, blockscout free);
  // a required capability with no serving provider throws (explicit degradation).
  getBlockByTime(unixSeconds: number): Promise<bigint>;
  getNativeBalanceAt(address: string, block: bigint): Promise<BalanceResult>;
  getErc20BalanceAt(address: string, token: string, block: bigint): Promise<BalanceResult>;
  // >50k probe (ADR-008 Q5): best-effort — degrades to undefined (no suggestion)
  // when no provider can serve it, so a gap never blocks onboarding.
  estimateTxCount(address: string): Promise<number | undefined>;
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

  // Capability routing (ADR-009): try providers in failover order, skipping any
  // that does not implement the capability, failing over on a ProviderError.
  const capabilityProviders: ChainDataProvider[] = [etherscan, blockscout];
  const requireCapability = async <R>(
    method: keyof ChainDataProvider,
    invoke: (p: ChainDataProvider) => Promise<R>,
    label: string,
  ): Promise<R> => {
    let last: unknown;
    let capable = false;
    for (const p of capabilityProviders) {
      if (typeof p[method] !== 'function') continue;
      capable = true;
      try {
        return await invoke(p);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        last = err;
      }
    }
    if (!capable) {
      throw new ProviderError('provider_error', `no provider serves ${label} on chain ${String(opts.chainId)}`);
    }
    throw last;
  };

  return {
    indexer,
    getReceipts,
    getBlockByTime: (unixSeconds) =>
      requireCapability('getBlockByTime', (p) => p.getBlockByTime!(opts.chainId, unixSeconds), 'block-by-time'),
    getNativeBalanceAt: (address, block) =>
      requireCapability(
        'getNativeBalanceAt',
        async (p) => ({ balance: await p.getNativeBalanceAt!(opts.chainId, address, block), provider: p.kind }),
        'native balance-at-block',
      ),
    getErc20BalanceAt: (address, token, block) =>
      requireCapability(
        'getErc20BalanceAt',
        async (p) => ({ balance: await p.getErc20BalanceAt!(opts.chainId, address, token, block), provider: p.kind }),
        'erc20 balance-at-block',
      ),
    estimateTxCount: async (address) => {
      // Best-effort (ADR-008 Q5): a provider gap or error yields no hint, never a throw.
      for (const p of capabilityProviders) {
        if (typeof p.estimateTxCount !== 'function') continue;
        try {
          return await p.estimateTxCount(opts.chainId, address);
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
        }
      }
      return undefined;
    },
  };
}

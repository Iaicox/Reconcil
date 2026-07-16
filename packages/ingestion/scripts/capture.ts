/**
 * One-off fixture capture (spec §9). Live network — never runs in CI or tests.
 *
 *   pnpm --filter @pet-crypto/ingestion capture -- \
 *     --wallet 0x… --role freelancer --chains 1,8453 [--from 0] [--to N]
 *
 * Requires ETHERSCAN_API_KEY in the environment (root .env is auto-loaded).
 */
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainById } from '@pet-crypto/core';
import { recordingTransport, realFetchJson } from '../src/fixture-transport.js';
import { assertScrubbed, readManifest, upsertManifest } from '../src/manifest.js';
import type { WalletManifestEntry } from '../src/manifest.js';
import { collectAllPages } from '../src/paging.js';
import { blockscoutAdapter } from '../src/providers/blockscout.js';
import { etherscanV2Adapter } from '../src/providers/etherscan-v2.js';
import type { ChainDataProvider, FetchJson, PageQuery } from '../src/types.js';

const FIXTURES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'evals',
  'fixtures',
  'providers',
);

function throttled(inner: FetchJson, ms: number): FetchJson {
  let last = 0;
  return async (url) => {
    const wait = last + ms - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
    return inner(url);
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      wallet: { type: 'string' },
      role: { type: 'string' },
      chains: { type: 'string', default: '1,8453' },
      from: { type: 'string', default: '0' },
      to: { type: 'string' },
    },
  });
  const wallet = values.wallet?.toLowerCase();
  const role = values.role;
  if (!wallet || !role) throw new Error('usage: capture --wallet 0x… --role freelancer|smb-stables|edge-spam');
  const apiKey = process.env['ETHERSCAN_API_KEY'];
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY is not set (put it in the root .env)');

  const manifestPath = join(FIXTURES_ROOT, 'manifest.json');
  const previous = readManifest(manifestPath).find((e) => e.address === wallet);
  const entry: WalletManifestEntry = {
    address: wallet,
    role,
    capturedAt: new Date().toISOString(),
    chains: previous?.chains ?? {},
  };

  for (const chainIdStr of values.chains.split(',')) {
    const chainId = Number(chainIdStr);
    const chain = chainById(chainId);
    const counts: Record<string, { native: number; erc20: number }> = {};
    const fromBlock = BigInt(values.from);
    let toBlock: bigint | undefined = values.to === undefined ? undefined : BigInt(values.to);

    for (const providerCfg of chain.providers) {
      const dir = join(FIXTURES_ROOT, providerCfg.kind, String(chainId));
      // 250 ms between Etherscan calls (free tier 5 req/s); be polite to Blockscout too
      const transport = recordingTransport(throttled(realFetchJson(), 250), dir);
      const provider: ChainDataProvider =
        providerCfg.kind === 'etherscan-v2'
          ? etherscanV2Adapter({ fetchJson: transport, baseUrl: providerCfg.baseUrl, apiKey })
          : blockscoutAdapter({ fetchJson: transport, baseUrl: providerCfg.baseUrl, chainId });

      // Pin the window on the FIRST provider of the chain; reuse for the second so
      // both providers capture the identical window (cross-provider test relies on it).
      if (toBlock === undefined) {
        const head = await provider.getHead(chainId);
        toBlock = head - chain.finalityDepth;
      }
      const q: PageQuery = { chainId, address: wallet, fromBlock, toBlock, limit: 1000, sort: 'asc' };

      console.log(`[${chain.name}/${providerCfg.kind}] window ${String(fromBlock)}..${String(toBlock)}`);
      const native = await collectAllPages((pq) => provider.getNativeTxs(pq), q);
      const erc20 = await collectAllPages((pq) => provider.getErc20Transfers(pq), q);
      counts[providerCfg.kind] = { native: native.length, erc20: erc20.length };
      console.log(`  native=${String(native.length)} erc20=${String(erc20.length)}`);

      // Balance-at-pin + token meta: Blockscout capability (Etherscan free tier lacks them)
      const contracts = [...new Set(erc20.map((t) => t.contractAddress.toLowerCase()))];
      if (provider.getNativeBalanceAt) await provider.getNativeBalanceAt(chainId, wallet, toBlock);
      if (provider.getErc20BalanceAt) {
        for (const c of contracts) await provider.getErc20BalanceAt(chainId, wallet, c, toBlock);
      }
      if (provider.getTokenMeta) {
        for (const c of contracts) await provider.getTokenMeta(chainId, c);
      }

      // Receipts for outgoing txs on receipts-opstack chains (both providers)
      if (chain.feeStrategy === 'receipts-opstack' && provider.getReceipts) {
        const outgoing = [...new Set(native.filter((t) => t.from.toLowerCase() === wallet).map((t) => t.hash))];
        await provider.getReceipts(chainId, outgoing);
        console.log(`  receipts=${String(outgoing.length)}`);
      }
    }

    entry.chains[String(chainId)] = {
      fromBlock: fromBlock.toString(),
      toBlock: (toBlock ?? 0n).toString(),
      counts,
    };
  }

  assertScrubbed(FIXTURES_ROOT, apiKey);
  upsertManifest(manifestPath, entry);
  console.log(`manifest updated: ${manifestPath}`);
}

await main();

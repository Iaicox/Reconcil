/**
 * One-off fixture capture (spec §9). Live network — never runs in CI or tests.
 *
 *   pnpm --filter @pet-crypto/ingestion capture -- \
 *     --wallet 0x… --role freelancer --chains 1,8453 [--from 0] [--to N]
 *
 * Requires ETHERSCAN_API_KEY in the environment (root .env is auto-loaded).
 */
import { parseArgs } from 'node:util';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainById } from '@pet-crypto/core';
import { recordingTransport, realFetchJson } from '../src/fixture-transport.js';
import { assertScrubbed, readManifest, upsertManifest } from '../src/manifest.js';
import type { WalletManifestEntry } from '../src/manifest.js';
import { collectAllPages } from '../src/paging.js';
import { blockscoutAdapter } from '../src/providers/blockscout.js';
import { etherscanV2Adapter } from '../src/providers/etherscan-v2.js';
import { ProviderError } from '../src/types.js';
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

/** Public instances rate-limit bursts; wait out 429/rate-limit envelopes and retry. */
function withRateLimitRetry(inner: FetchJson, attempts = 5, backoffMs = 6000): FetchJson {
  return async (url) => {
    for (let attempt = 1; ; attempt++) {
      const res = await inner(url);
      if (attempt >= attempts || !isRateLimited(res)) return res;
      console.log(`  rate-limited, retry ${String(attempt)}/${String(attempts - 1)} in ${String(backoffMs)}ms`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  };
}

function isRateLimited(res: { status: number; body: unknown }): boolean {
  if (res.status === 429 || res.status >= 500) return true; // 5xx: public instances hiccup
  if (typeof res.body !== 'object' || res.body === null) return false;
  const b = res.body as { status?: unknown; message?: unknown; result?: unknown };
  if (b.status !== '0') return false;
  const text = typeof b.result === 'string' ? b.result : typeof b.message === 'string' ? b.message : '';
  return /rate limit/i.test(text);
}

/**
 * Fixture diet: tx-list rows carry the full calldata in `input` (Blockscout
 * pages hit 90 MB on airdrop-batch txs). No Raw* schema reads `input`, so
 * prune it in every recorded account-module response before committing.
 */
function pruneRecordedInputs(rootDir: string): void {
  let pruned = 0;
  for (const dirent of readdirSync(rootDir, { withFileTypes: true, recursive: true })) {
    if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
    const path = join(dirent.parentPath, dirent.name);
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as {
      response?: { body?: { result?: unknown } };
    };
    const result = fixture.response?.body?.result;
    if (!Array.isArray(result)) continue;
    let touched = false;
    for (const row of result) {
      if (typeof row === 'object' && row !== null && 'input' in row) {
        const r = row as { input: unknown };
        if (typeof r.input === 'string' && r.input.length > 10) {
          r.input = '<pruned>';
          touched = true;
        }
      }
    }
    if (touched) {
      writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
      pruned++;
    }
  }
  console.log(`pruned input calldata in ${String(pruned)} fixture file(s)`);
}

/** Meta/balance calls are 2×contracts; spam wallets have hundreds. Cap keeps capture bounded. */
const CONTRACT_CAP = 40;

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
      // 250 ms between Etherscan calls (free tier 5 req/s); keyless public
      // Blockscout throttles harder — 1 s spacing + retry on rate-limit replies.
      const spacingMs = providerCfg.kind === 'etherscan-v2' ? 250 : 1000;
      const transport = recordingTransport(
        withRateLimitRetry(throttled(realFetchJson(), spacingMs)),
        dir,
      );
      const provider: ChainDataProvider =
        providerCfg.kind === 'etherscan-v2'
          ? etherscanV2Adapter({ fetchJson: transport, baseUrl: providerCfg.baseUrl, apiKey })
          : blockscoutAdapter({ fetchJson: transport, baseUrl: providerCfg.baseUrl, chainId });

      try {
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

        // Balance-at-pin + token meta: Blockscout capability (Etherscan free tier lacks them)
        const contracts = [...new Set(erc20.map((t) => t.contractAddress.toLowerCase()))].slice(
          0,
          CONTRACT_CAP,
        );
        if (provider.getNativeBalanceAt) await provider.getNativeBalanceAt(chainId, wallet, toBlock);
        if (provider.getErc20BalanceAt) {
          for (const c of contracts) await provider.getErc20BalanceAt(chainId, wallet, c, toBlock);
        }
        if (provider.getTokenMeta) {
          for (const c of contracts) await provider.getTokenMeta(chainId, c);
        }

        // Receipts for outgoing txs on receipts-opstack chains. Non-fatal: on Base
        // neither free-tier Etherscan nor Blockscout's compat API serves proxy
        // receipts — the fee path uses public RPC instead (03-ingestion §6,
        // worker slice), so missing receipt fixtures must not sink the capture.
        if (chain.feeStrategy === 'receipts-opstack' && provider.getReceipts) {
          const outgoing = [...new Set(native.filter((t) => t.from.toLowerCase() === wallet).map((t) => t.hash))];
          try {
            await provider.getReceipts(chainId, outgoing);
            console.log(`  receipts=${String(outgoing.length)}`);
          } catch (err) {
            if (!(err instanceof ProviderError)) throw err;
            console.log(`  receipts unavailable: ProviderError(${err.kind}) — RPC fee path is the worker slice`);
          }
        }

        // Counts land in the manifest only after the provider's full walk succeeded.
        counts[providerCfg.kind] = { native: native.length, erc20: erc20.length };
        console.log(`  native=${String(native.length)} erc20=${String(erc20.length)}`);
      } catch (err) {
        // A provider can legitimately refuse a chain (e.g. Etherscan free tier
        // does not cover Base) — skip it, the other provider still captures.
        if (!(err instanceof ProviderError)) throw err;
        console.log(`[${chain.name}/${providerCfg.kind}] skipped: ProviderError(${err.kind})`);
      }
    }

    if (Object.keys(counts).length === 0) {
      throw new Error(`no provider succeeded for chain ${String(chainId)}`);
    }
    entry.chains[String(chainId)] = {
      fromBlock: fromBlock.toString(),
      toBlock: (toBlock ?? 0n).toString(),
      counts,
    };
  }

  pruneRecordedInputs(FIXTURES_ROOT);
  assertScrubbed(FIXTURES_ROOT, apiKey);
  upsertManifest(manifestPath, entry);
  console.log(`manifest updated: ${manifestPath}`);
}

await main();

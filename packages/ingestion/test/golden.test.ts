import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureTransport } from '../src/fixture-transport.js';
import { readManifest } from '../src/manifest.js';
import { normalize } from '../src/normalize.js';
import { collectAllPages } from '../src/paging.js';
import { blockscoutAdapter } from '../src/providers/blockscout.js';
import { etherscanV2Adapter } from '../src/providers/etherscan-v2.js';
import type {
  ChainDataProvider,
  NormalizedEvent,
  PageQuery,
  RawErc20Transfer,
  RawNativeTx,
} from '../src/types.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'evals', 'fixtures', 'providers');
const manifest = readManifest(join(ROOT, 'manifest.json'));

// Mirrors chains.config.ts (asserted equal by the core test suite); kept inline
// so the golden suite stays self-contained.
const FEE: Record<string, 'txlist' | 'receipts-opstack'> = { '1': 'txlist', '8453': 'receipts-opstack' };

function makeProvider(kind: string, chainId: number): ChainDataProvider {
  const fetchJson = fixtureTransport(join(ROOT, kind, String(chainId)));
  return kind === 'etherscan-v2'
    ? etherscanV2Adapter({
        fetchJson,
        baseUrl: 'https://api.etherscan.io/v2/api',
        apiKey: 'REDACTED', // canonicalization redacts the key, so REDACTED replays
      })
    : blockscoutAdapter({
        fetchJson,
        baseUrl: chainId === 1 ? 'https://eth.blockscout.com/api' : 'https://base.blockscout.com/api',
        chainId,
      });
}

interface Replayed {
  native: RawNativeTx[];
  erc20: RawErc20Transfer[];
}

async function replay(kind: string, chainId: string, address: string, window: { fromBlock: string; toBlock: string }): Promise<Replayed> {
  const provider = makeProvider(kind, Number(chainId));
  const q: PageQuery = {
    chainId: Number(chainId),
    address,
    fromBlock: BigInt(window.fromBlock),
    toBlock: BigInt(window.toBlock),
    limit: 1000,
    sort: 'asc',
  };
  const native = await collectAllPages((pq) => provider.getNativeTxs(pq), q);
  const erc20 = await collectAllPages((pq) => provider.getErc20Transfers(pq), q);
  return { native, erc20 };
}

/** normalize() native+gas events only — erc20 has no provider logIndex (spec §11). */
function normalizeNative(r: Replayed, chainId: string, address: string, kind: string): NormalizedEvent[] {
  if (FEE[chainId] !== 'txlist') {
    throw new Error(`normalizeNative is txlist-only; chain ${chainId} needs receipts (worker slice)`);
  }
  return normalize(
    { native: { items: r.native } },
    { chainId: Number(chainId), trackedAddress: address, feeStrategy: 'txlist', provider: kind },
  );
}

function nativeTriples(events: NormalizedEvent[]): string[] {
  return events
    .map((e) => `${e.eventKind}:${e.txHash}:${String(e.logIndex)}:${String(e.amountRaw)}`)
    .sort();
}

function erc20Tuples(rows: RawErc20Transfer[]): string[] {
  return rows
    .map((r) => `${r.hash.toLowerCase()}:${r.contractAddress.toLowerCase()}:${r.value}:${r.blockNumber}`)
    .sort();
}

describe('golden replay of recorded fixtures', () => {
  it('manifest lists the three recorded wallets (suite must never silently skip)', () => {
    expect(manifest.length).toBe(3);
  });

  for (const wallet of manifest) {
    for (const [chainId, window] of Object.entries(wallet.chains)) {
      describe(`${wallet.role} on chain ${chainId}`, () => {
        it('replays each provider to the exact counts recorded at capture', async () => {
          for (const [kind, counts] of Object.entries(window.counts)) {
            const r = await replay(kind, chainId, wallet.address, window);
            expect({ provider: kind, native: r.native.length, erc20: r.erc20.length }).toEqual({
              provider: kind,
              ...counts,
            });
          }
        });

        it('normalized native+gas events satisfy structural invariants', async () => {
          // receipts-opstack chains cannot synthesize gas without RPC receipts
          // (worker slice) — raw replay above still covers them.
          if (FEE[chainId] !== 'txlist') return;
          for (const kind of Object.keys(window.counts)) {
            const r = await replay(kind, chainId, wallet.address, window);
            const events = normalizeNative(r, chainId, wallet.address, kind);
            expect(events.length).toBeGreaterThan(0);
            for (const e of events) {
              expect(e.amountRaw).toBeGreaterThanOrEqual(0n);
              expect(e.txHash).toBe(e.txHash.toLowerCase());
              expect(e.fromAddr).toBe(e.fromAddr.toLowerCase());
              expect(e.toAddr).toBe(e.toAddr.toLowerCase());
              if (e.eventKind === 'gas_fee') {
                expect(e.fromAddr).toBe(wallet.address);
                expect(e.logIndex).toBe(-2);
              }
              if (e.eventKind === 'native_transfer') expect(e.logIndex).toBe(-1);
            }
          }
        });

        it('erc20 rows carry no provider logIndex — the §11 gap the worker slice closes', async () => {
          for (const kind of Object.keys(window.counts)) {
            const r = await replay(kind, chainId, wallet.address, window);
            for (const row of r.erc20) expect(row.logIndex).toBeNull();
          }
        });

        it('both providers agree: normalized native+gas sets and raw erc20 tuple sets match (ADR-009)', async () => {
          const kinds = Object.keys(window.counts);
          if (kinds.length < 2) return;
          const replays = await Promise.all(kinds.map((k) => replay(k, chainId, wallet.address, window)));
          const [a, b] = replays;
          if (!a || !b) throw new Error('expected two provider replays');
          expect(erc20Tuples(a.erc20)).toEqual(erc20Tuples(b.erc20));
          if (FEE[chainId] === 'txlist') {
            const [ka, kb] = kinds;
            expect(nativeTriples(normalizeNative(a, chainId, wallet.address, ka ?? ''))).toEqual(
              nativeTriples(normalizeNative(b, chainId, wallet.address, kb ?? '')),
            );
          }
        });
      });
    }
  }
});

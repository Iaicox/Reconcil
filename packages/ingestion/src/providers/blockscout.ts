import { z } from 'zod';
import type {
  ChainDataProvider,
  FetchJson,
  Page,
  PageQuery,
  RawErc20Transfer,
  RawNativeTx,
  RawReceipt,
  RawTokenMeta,
} from '../types.js';
import { ProviderError } from '../types.js';
import { decQuantity, parseRows, unwrapAccountEnvelope, unwrapProxy, unwrapProxyHex } from './envelope.js';
import { mapReceipt, mapTokenRows, mapTxRows, receiptResult, tokenRow, txRow } from './etherscan-v2.js';

const tokenMetaResult = z.object({
  contractAddress: z.string().optional(),
  name: z.string(),
  symbol: z.string(),
  decimals: z.string(),
});

/**
 * Blockscout etherscan-compatible API. Instances are per-chain (baseUrl encodes
 * the chain), keyless. NB: exact shapes of eth_get_balance / tokenbalance /
 * getToken are verified against reality at capture time (spec §7 escape hatch).
 */
export function blockscoutAdapter(opts: {
  fetchJson: FetchJson;
  baseUrl: string;
  chainId: number;
}): ChainDataProvider {
  const assertChain = (chainId: number): void => {
    if (chainId !== opts.chainId) {
      throw new ProviderError(
        'provider_error',
        `blockscout adapter is bound to chain ${String(opts.chainId)}, got ${String(chainId)}`,
      );
    }
  };

  const call = async (params: Record<string, string>): Promise<{ status: number; body: unknown }> => {
    const u = new URL(opts.baseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return opts.fetchJson(u.toString());
  };

  return {
    kind: 'blockscout',

    async getHead(chainId: number): Promise<bigint> {
      assertChain(chainId);
      // module=block is the portable Blockscout action: base.blockscout.com
      // rejects module=proxy with "Unknown module" (verified at capture).
      const { status, body } = await call({ module: 'block', action: 'eth_block_number' });
      return unwrapProxyHex(status, body);
    },

    async getNativeTxs(q: PageQuery): Promise<Page<RawNativeTx>> {
      assertChain(q.chainId);
      const { status, body } = await call({
        module: 'account',
        action: 'txlist',
        address: q.address,
        startblock: q.fromBlock.toString(),
        endblock: q.toBlock.toString(),
        page: '1',
        offset: String(q.limit),
        sort: q.sort,
      });
      const rows = parseRows(z.array(txRow), unwrapAccountEnvelope(status, body));
      return { items: mapTxRows(rows) };
    },

    async getErc20Transfers(q: PageQuery): Promise<Page<RawErc20Transfer>> {
      assertChain(q.chainId);
      const { status, body } = await call({
        module: 'account',
        action: 'tokentx',
        address: q.address,
        startblock: q.fromBlock.toString(),
        endblock: q.toBlock.toString(),
        page: '1',
        offset: String(q.limit),
        sort: q.sort,
      });
      const rows = parseRows(z.array(tokenRow), unwrapAccountEnvelope(status, body));
      return { items: mapTokenRows(rows) };
    },

    async getTokenMeta(chainId: number, address: string): Promise<RawTokenMeta> {
      assertChain(chainId);
      const { status, body } = await call({
        module: 'token',
        action: 'getToken',
        contractaddress: address,
      });
      const meta = parseRows(tokenMetaResult, unwrapAccountEnvelope(status, body));
      return {
        contractAddress: (meta.contractAddress ?? address).toLowerCase(),
        name: meta.name,
        symbol: meta.symbol,
        decimals: meta.decimals,
      };
    },

    async getNativeBalanceAt(chainId: number, address: string, block: bigint): Promise<bigint> {
      assertChain(chainId);
      const { status, body } = await call({
        module: 'account',
        action: 'eth_get_balance',
        address,
        block: block.toString(),
      });
      // eth_get_balance answers in JSON-RPC shape, not the account envelope
      // (verified against eth.blockscout.com at fixture capture, spec §7).
      return unwrapProxyHex(status, body);
    },

    async getErc20BalanceAt(
      chainId: number,
      address: string,
      token: string,
      block: bigint,
    ): Promise<bigint> {
      assertChain(chainId);
      const { status, body } = await call({
        module: 'account',
        action: 'tokenbalance',
        contractaddress: token,
        address,
        block: block.toString(),
      });
      // decQuantity: base.blockscout.com answers status:"1" result:"" for
      // historical blocks it cannot serve (true zero balances come back as "0")
      // — an empty string must fail loudly, never coin 0n via BigInt('').
      return BigInt(parseRows(decQuantity, unwrapAccountEnvelope(status, body)));
    },

    async getReceipts(chainId: number, txHashes: string[]): Promise<RawReceipt[]> {
      assertChain(chainId);
      const receipts: RawReceipt[] = [];
      for (const hash of txHashes) {
        const { status, body } = await call({
          module: 'proxy',
          action: 'eth_getTransactionReceipt',
          txhash: hash,
        });
        receipts.push(mapReceipt(unwrapProxy(status, body, receiptResult)));
      }
      return receipts;
    },
  };
}

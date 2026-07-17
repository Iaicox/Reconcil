import { z } from 'zod';
import type {
  ChainDataProvider,
  FetchJson,
  Page,
  PageQuery,
  RawErc20Transfer,
  RawNativeTx,
  RawReceipt,
} from '../types.js';
import { parseRows, unwrapAccountEnvelope, unwrapProxy, unwrapProxyHex } from './envelope.js';

const txRow = z.object({
  blockNumber: z.string(),
  timeStamp: z.string(),
  hash: z.string(),
  from: z.string(),
  to: z.string(),
  value: z.string(),
  gasUsed: z.string(),
  gasPrice: z.string(),
  isError: z.enum(['0', '1']),
});

const tokenRow = z.object({
  blockNumber: z.string(),
  timeStamp: z.string(),
  hash: z.string(),
  logIndex: z.string().optional(),
  from: z.string(),
  to: z.string(),
  contractAddress: z.string(),
  value: z.string(),
  // Blockscout returns null name/symbol for metadata-less spam tokens
  // (observed in edge-spam fixtures, 2026-07-17)
  tokenName: z.string().nullable(),
  tokenSymbol: z.string().nullable(),
  tokenDecimal: z.string(),
});

const receiptResult = z.object({
  transactionHash: z.string(),
  gasUsed: z.string(),
  effectiveGasPrice: z.string(),
  status: z.enum(['0x0', '0x1']),
  l1Fee: z.string().optional(),
});

export function mapTxRows(rows: z.infer<typeof txRow>[]): RawNativeTx[] {
  return rows.map((r) => ({
    blockNumber: r.blockNumber,
    timeStamp: r.timeStamp,
    hash: r.hash,
    from: r.from,
    to: r.to === '' ? null : r.to,
    value: r.value,
    gasUsed: r.gasUsed,
    gasPrice: r.gasPrice,
    isError: r.isError,
  }));
}

export function mapTokenRows(rows: z.infer<typeof tokenRow>[]): RawErc20Transfer[] {
  return rows.map((r) => ({
    blockNumber: r.blockNumber,
    timeStamp: r.timeStamp,
    hash: r.hash,
    logIndex: r.logIndex ?? null,
    from: r.from,
    to: r.to,
    contractAddress: r.contractAddress,
    value: r.value,
    tokenName: r.tokenName ?? '',
    tokenSymbol: r.tokenSymbol ?? '',
    tokenDecimal: r.tokenDecimal,
  }));
}

export function mapReceipt(r: z.infer<typeof receiptResult>): RawReceipt {
  return {
    transactionHash: r.transactionHash.toLowerCase(),
    gasUsed: BigInt(r.gasUsed).toString(),
    effectiveGasPrice: BigInt(r.effectiveGasPrice).toString(),
    l1Fee: r.l1Fee === undefined ? null : BigInt(r.l1Fee).toString(),
    status: r.status === '0x1' ? '1' : '0',
  };
}

export { txRow, tokenRow, receiptResult };

export function etherscanV2Adapter(opts: {
  fetchJson: FetchJson;
  baseUrl: string;
  apiKey: string;
}): ChainDataProvider {
  const call = async (params: Record<string, string>): Promise<{ status: number; body: unknown }> => {
    const u = new URL(opts.baseUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('apikey', opts.apiKey);
    return opts.fetchJson(u.toString());
  };

  return {
    kind: 'etherscan-v2',

    async getHead(chainId: number): Promise<bigint> {
      const { status, body } = await call({
        chainid: String(chainId),
        module: 'proxy',
        action: 'eth_blockNumber',
      });
      return unwrapProxyHex(status, body);
    },

    async getNativeTxs(q: PageQuery): Promise<Page<RawNativeTx>> {
      const { status, body } = await call({
        chainid: String(q.chainId),
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
      const { status, body } = await call({
        chainid: String(q.chainId),
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

    async getReceipts(chainId: number, txHashes: string[]): Promise<RawReceipt[]> {
      const receipts: RawReceipt[] = [];
      for (const hash of txHashes) {
        const { status, body } = await call({
          chainid: String(chainId),
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

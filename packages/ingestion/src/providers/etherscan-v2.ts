import { z } from 'zod';
import type {
  ChainDataProvider,
  FetchJson,
  Page,
  PageQuery,
  RawErc20Transfer,
  RawInternalTx,
  RawNativeTx,
  RawReceipt,
} from '../types.js';
import {
  decQuantity,
  hexQuantity,
  parseRows,
  unwrapAccountEnvelope,
  unwrapProxy,
  unwrapProxyHex,
} from './envelope.js';

// Numeric fields feed BigInt()/Number() in normalize() — decQuantity/hexQuantity
// reject non-numeric text here as malformed (see envelope.ts).
const txRow = z.object({
  blockNumber: decQuantity,
  timeStamp: decQuantity,
  hash: z.string(),
  from: z.string(),
  to: z.string(),
  value: decQuantity,
  gasUsed: decQuantity,
  gasPrice: decQuantity,
  isError: z.enum(['0', '1']),
});

// txlistinternal rows carry the same numeric-string discipline as txlist but no gas
// (the parent tx's fee already covers it). `to` is '' for internal contract creations.
// The parent-tx hash key differs by provider — Etherscan V2 sends `hash`, Blockscout's
// etherscan-compat shim sends `transactionHash` (verified at capture, spec §7) — so
// accept either and coalesce in mapInternalRows. Same story for the trace's position
// inside its parent tx: Etherscan `traceId` ("0_1"), Blockscout `index` ("67") — kept
// as free-form text (not decQuantity: the dotted form is not a number) because it is
// only ever an ordering key inside normalize(), never arithmetic and never wire-bound.
const internalRow = z
  .object({
    blockNumber: decQuantity,
    timeStamp: decQuantity,
    hash: z.string().optional(),
    transactionHash: z.string().optional(),
    from: z.string(),
    to: z.string(),
    value: decQuantity,
    isError: z.enum(['0', '1']),
    traceId: z.string().optional(),
    index: z.string().optional(),
  })
  .refine((r) => r.hash !== undefined || r.transactionHash !== undefined, 'missing parent tx hash');

const tokenRow = z.object({
  blockNumber: decQuantity,
  timeStamp: decQuantity,
  hash: z.string(),
  // nullish: neither provider sends logIndex today (spec §11), and Blockscout
  // uses explicit nulls for absent values (cf. tokenName below)
  logIndex: decQuantity.nullish(),
  from: z.string(),
  to: z.string(),
  contractAddress: z.string(),
  value: decQuantity,
  // Blockscout returns null name/symbol for metadata-less spam tokens
  // (observed in edge-spam fixtures, 2026-07-17)
  tokenName: z.string().nullable(),
  tokenSymbol: z.string().nullable(),
  tokenDecimal: z.string(),
});

const logEntry = z.object({
  logIndex: hexQuantity,
  address: z.string(),
  topics: z.array(z.string()),
  data: z.string(),
});

const receiptResult = z.object({
  transactionHash: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  gasUsed: hexQuantity,
  effectiveGasPrice: hexQuantity,
  status: z.enum(['0x0', '0x1']),
  l1Fee: hexQuantity.optional(),
  logs: z.array(logEntry),
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

export function mapInternalRows(rows: z.infer<typeof internalRow>[]): RawInternalTx[] {
  return rows.map((r) => ({
    blockNumber: r.blockNumber,
    timeStamp: r.timeStamp,
    // refine() above guarantees at least one is present.
    hash: (r.transactionHash ?? r.hash)!,
    from: r.from,
    to: r.to === '' ? null : r.to,
    value: r.value,
    isError: r.isError,
    // Whichever of the two the provider sent (see internalRow); '' counts as absent.
    traceId: (r.traceId ?? r.index) || undefined,
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
    from: r.from.toLowerCase(),
    to: r.to === null ? null : r.to.toLowerCase(),
    gasUsed: BigInt(r.gasUsed).toString(),
    effectiveGasPrice: BigInt(r.effectiveGasPrice).toString(),
    l1Fee: r.l1Fee === undefined ? null : BigInt(r.l1Fee).toString(),
    status: r.status === '0x1' ? '1' : '0',
    logs: r.logs.map((l) => ({
      logIndex: Number(BigInt(l.logIndex)),
      address: l.address.toLowerCase(),
      topics: l.topics,
      data: l.data,
    })),
  };
}

export { txRow, internalRow, tokenRow, receiptResult };

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

    async getInternalTxs(q: PageQuery): Promise<Page<RawInternalTx>> {
      const { status, body } = await call({
        chainid: String(q.chainId),
        module: 'account',
        action: 'txlistinternal',
        address: q.address,
        startblock: q.fromBlock.toString(),
        endblock: q.toBlock.toString(),
        page: '1',
        offset: String(q.limit),
        sort: q.sort,
      });
      const rows = parseRows(z.array(internalRow), unwrapAccountEnvelope(status, body));
      return { items: mapInternalRows(rows) };
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

    async getBlockByTime(chainId: number, unixSeconds: number): Promise<bigint> {
      const { status, body } = await call({
        chainid: String(chainId),
        module: 'block',
        action: 'getblocknobytime',
        timestamp: String(unixSeconds),
        closest: 'before',
      });
      // Account envelope with a decimal block-number string; decQuantity rejects
      // empty/hostile text before it reaches BigInt() (ADR-011).
      return BigInt(parseRows(decQuantity, unwrapAccountEnvelope(status, body)));
    },

    async estimateTxCount(chainId: number, address: string): Promise<number> {
      // Account nonce = outbound tx count: a cheap lower bound for the >50k probe
      // (ADR-008 Q5). Proxy is free-tier on Ethereum; on Base the free tier errors
      // and the bundle degrades the probe (no suggestion) rather than guessing.
      const { status, body } = await call({
        chainid: String(chainId),
        module: 'proxy',
        action: 'eth_getTransactionCount',
        address,
        tag: 'latest',
      });
      return Number(unwrapProxyHex(status, body));
    },
  };
}

import { describe, expect, it } from 'vitest';
import { etherscanV2Adapter } from '../src/providers/etherscan-v2.js';
import { ProviderError } from '../src/types.js';
import type { FetchJson, PageQuery } from '../src/types.js';

const BASE = 'https://api.etherscan.io/v2/api';
const KEY = 'TESTKEY';

function stub(body: unknown, status = 200): { transport: FetchJson; calls: string[] } {
  const calls: string[] = [];
  const transport: FetchJson = (url) => {
    calls.push(url);
    return Promise.resolve({ status, body });
  };
  return { transport, calls };
}

function adapter(transport: FetchJson) {
  return etherscanV2Adapter({ fetchJson: transport, baseUrl: BASE, apiKey: KEY });
}

const Q: PageQuery = {
  chainId: 1,
  address: '0xAbCd000000000000000000000000000000000001',
  fromBlock: 0n,
  toBlock: 100n,
  limit: 1000,
  sort: 'asc',
};

// realistic etherscan txlist row (extra fields must be tolerated and dropped)
const TX_ROW = {
  blockNumber: '19000000',
  timeStamp: '1700000000',
  hash: '0xAAA1000000000000000000000000000000000000000000000000000000000001',
  nonce: '5',
  from: '0xABCD000000000000000000000000000000000001',
  to: '0xdef0000000000000000000000000000000002',
  value: '1000000000000000000',
  gas: '21000',
  gasPrice: '20000000000',
  gasUsed: '21000',
  isError: '0',
  txreceipt_status: '1',
  input: '0x',
  confirmations: '100',
};

describe('getNativeTxs', () => {
  it('builds the txlist URL with all paging params and the key', async () => {
    const { transport, calls } = stub({ status: '1', message: 'OK', result: [TX_ROW] });
    await adapter(transport).getNativeTxs(Q);
    const u = new URL(calls[0] ?? '');
    expect(u.searchParams.get('module')).toBe('account');
    expect(u.searchParams.get('action')).toBe('txlist');
    expect(u.searchParams.get('chainid')).toBe('1');
    expect(u.searchParams.get('address')).toBe(Q.address);
    expect(u.searchParams.get('startblock')).toBe('0');
    expect(u.searchParams.get('endblock')).toBe('100');
    expect(u.searchParams.get('page')).toBe('1');
    expect(u.searchParams.get('offset')).toBe('1000');
    expect(u.searchParams.get('sort')).toBe('asc');
    expect(u.searchParams.get('apikey')).toBe(KEY);
  });

  it('maps rows to RawNativeTx, keeping strings as-is', async () => {
    const { transport } = stub({ status: '1', message: 'OK', result: [TX_ROW] });
    const page = await adapter(transport).getNativeTxs(Q);
    expect(page.items).toEqual([
      {
        blockNumber: '19000000',
        timeStamp: '1700000000',
        hash: TX_ROW.hash,
        from: TX_ROW.from,
        to: TX_ROW.to,
        value: '1000000000000000000',
        gasUsed: '21000',
        gasPrice: '20000000000',
        isError: '0',
      },
    ]);
  });

  it('maps empty-string `to` (contract creation) to null', async () => {
    const { transport } = stub({ status: '1', message: 'OK', result: [{ ...TX_ROW, to: '' }] });
    const page = await adapter(transport).getNativeTxs(Q);
    expect(page.items[0]?.to).toBeNull();
  });

  it('treats status:0 "No transactions found" as an empty page', async () => {
    const { transport } = stub({ status: '0', message: 'No transactions found', result: [] });
    const page = await adapter(transport).getNativeTxs(Q);
    expect(page.items).toEqual([]);
  });

  it('maps rate-limit responses to ProviderError(rate_limited)', async () => {
    const { transport } = stub({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' });
    await expect(adapter(transport).getNativeTxs(Q)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'rate_limited',
    });
    // provider strings are hostile: the error message must not embed response content
    await adapter(transport)
      .getNativeTxs(Q)
      .catch((e: ProviderError) => expect(e.message).not.toContain('Max rate limit reached'));
  });

  it('maps HTTP 429 to rate_limited and HTTP 500 to http', async () => {
    const a429 = adapter(stub({}, 429).transport);
    await expect(a429.getNativeTxs(Q)).rejects.toMatchObject({ kind: 'rate_limited' });
    const a500 = adapter(stub({}, 500).transport);
    await expect(a500.getNativeTxs(Q)).rejects.toMatchObject({ kind: 'http' });
  });

  it('maps other status:0 envelopes to provider_error', async () => {
    const { transport } = stub({ status: '0', message: 'NOTOK', result: 'Invalid address format' });
    await expect(adapter(transport).getNativeTxs(Q)).rejects.toMatchObject({
      kind: 'provider_error',
    });
    // provider strings are hostile: the error message must not embed response content
    await adapter(transport)
      .getNativeTxs(Q)
      .catch((e: ProviderError) => expect(e.message).not.toContain('Invalid address format'));
  });

  it('maps Zod-rejected rows to malformed', async () => {
    const { transport } = stub({ status: '1', message: 'OK', result: [{ nope: true }] });
    await expect(adapter(transport).getNativeTxs(Q)).rejects.toMatchObject({ kind: 'malformed' });
    // token strings are hostile: the error message must not embed response content
    await adapter(transport)
      .getNativeTxs(Q)
      .catch((e: ProviderError) => expect(e.message).not.toContain('nope'));
  });
});

describe('getErc20Transfers', () => {
  const TOKEN_ROW = {
    blockNumber: '19000001',
    timeStamp: '1700000100',
    hash: '0xBBB2000000000000000000000000000000000000000000000000000000000002',
    from: '0xABCD000000000000000000000000000001',
    to: '0xDEF0000000000000000000000000000002',
    contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    value: '2500000',
    tokenName: 'USD Coin',
    tokenSymbol: 'USDC',
    tokenDecimal: '6',
    logIndex: '42',
    transactionIndex: '7',
    gasPrice: '20000000000',
    gasUsed: '65000',
  };

  it('maps rows to RawErc20Transfer with logIndex', async () => {
    const { transport, calls } = stub({ status: '1', message: 'OK', result: [TOKEN_ROW] });
    const page = await adapter(transport).getErc20Transfers(Q);
    expect(new URL(calls[0] ?? '').searchParams.get('action')).toBe('tokentx');
    expect(page.items).toEqual([
      {
        blockNumber: '19000001',
        timeStamp: '1700000100',
        hash: TOKEN_ROW.hash,
        logIndex: '42',
        from: TOKEN_ROW.from,
        to: TOKEN_ROW.to,
        contractAddress: TOKEN_ROW.contractAddress,
        value: '2500000',
        tokenName: 'USD Coin',
        tokenSymbol: 'USDC',
        tokenDecimal: '6',
      },
    ]);
  });

  it('maps a missing logIndex to null (spec §11)', async () => {
    const rowNoLogIndex = Object.fromEntries(
      Object.entries(TOKEN_ROW).filter(([k]) => k !== 'logIndex'),
    );
    const { transport } = stub({ status: '1', message: 'OK', result: [rowNoLogIndex] });
    const page = await adapter(transport).getErc20Transfers(Q);
    expect(page.items[0]?.logIndex).toBeNull();
  });
});

describe('getHead', () => {
  it('parses the proxy hex block number', async () => {
    const { transport, calls } = stub({ jsonrpc: '2.0', id: 83, result: '0x1233abc' });
    const head = await adapter(transport).getHead(1);
    expect(head).toBe(0x1233abcn);
    const u = new URL(calls[0] ?? '');
    expect(u.searchParams.get('module')).toBe('proxy');
    expect(u.searchParams.get('action')).toBe('eth_blockNumber');
  });
});

describe('getReceipts', () => {
  it('fetches per hash and converts hex fields to decimal strings', async () => {
    const receiptBody = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        transactionHash: '0xCCC3000000000000000000000000000000000000000000000000000000000003',
        gasUsed: '0xfde8', // 65000
        effectiveGasPrice: '0x4a817c800', // 20000000000
        status: '0x1',
        l1Fee: '0x2710', // 10000
      },
    };
    const { transport, calls } = stub(receiptBody);
    const receipts = await adapter(transport).getReceipts(1, [
      '0xCCC3000000000000000000000000000000000000000000000000000000000003',
    ]);
    expect(receipts).toEqual([
      {
        transactionHash:
          '0xccc3000000000000000000000000000000000000000000000000000000000003',
        gasUsed: '65000',
        effectiveGasPrice: '20000000000',
        l1Fee: '10000',
        status: '1',
      },
    ]);
    expect(new URL(calls[0] ?? '').searchParams.get('action')).toBe('eth_getTransactionReceipt');
  });

  it('returns l1Fee null when absent (L1 receipts)', async () => {
    const receiptBody = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        transactionHash: '0xCCC3000000000000000000000000000000000000000000000000000000000003',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x4a817c800',
        status: '0x1',
      },
    };
    const { transport } = stub(receiptBody);
    const receipts = await adapter(transport).getReceipts(1, ['0xccc3']);
    expect(receipts[0]?.l1Fee).toBeNull();
  });
});

describe('capabilities', () => {
  it('does not expose PRO-only capabilities (ADR-009 degradation)', () => {
    const a = adapter(stub({}).transport);
    expect(a.getTokenMeta).toBeUndefined();
    expect(a.getNativeBalanceAt).toBeUndefined();
    expect(a.getErc20BalanceAt).toBeUndefined();
    expect(a.kind).toBe('etherscan-v2');
  });
});

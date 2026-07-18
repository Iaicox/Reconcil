/**
 * Shared shapes for the ingestion slice (spec §5). Raw* values stay strings —
 * canonical semantics (bigint, lowercase) is normalize()'s job.
 */

/** Transport seam — deliberately dumb: no retries, no throttling (worker spec wraps it). */
export type FetchJson = (url: string) => Promise<{ status: number; body: unknown }>;

export interface PageQuery {
  chainId: number;
  address: string;
  fromBlock: bigint;
  toBlock: bigint;
  limit: number;
  sort: 'asc';
}

export interface Page<T> {
  items: T[];
}

export interface RawNativeTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string | null; // null: contract creation
  value: string;
  gasUsed: string;
  gasPrice: string;
  isError: '0' | '1';
}

export interface RawErc20Transfer {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  logIndex: string | null; // null when the provider omits it — spec §11
  from: string;
  to: string;
  contractAddress: string;
  value: string;
  tokenName: string; // hostile pass-through (ADR-011)
  tokenSymbol: string; // hostile pass-through (ADR-011)
  tokenDecimal: string;
}

export interface RawTokenMeta {
  contractAddress: string;
  name: string;
  symbol: string;
  decimals: string;
}

export interface RawLog {
  logIndex: number; // decoded from hex at the adapter boundary
  address: string; // emitting contract (lowercase)
  topics: string[]; // topic0 = event sig; ERC-20 Transfer has exactly 3 topics
  data: string; // 0x-hex; ERC-20 Transfer value
}

export interface RawReceipt {
  transactionHash: string;
  from: string; // tx-level sender (lowercase) → chain_events.tx_from
  to: string | null; // tx-level target (lowercase) → chain_events.tx_to; null on contract creation
  gasUsed: string; // decimal string (adapters convert hex)
  effectiveGasPrice: string; // decimal string
  l1Fee: string | null; // decimal string; null on non-OP-stack chains
  status: '0' | '1';
  logs: RawLog[];
}

/** Per 03-ingestion §5 / ADR-009: optional methods are capabilities. */
export interface ChainDataProvider {
  // (string & {}) keeps the known literals in autocomplete without collapsing to string
  readonly kind: 'etherscan-v2' | 'blockscout' | (string & {});
  getHead(chainId: number): Promise<bigint>;
  getNativeTxs(q: PageQuery): Promise<Page<RawNativeTx>>;
  getErc20Transfers(q: PageQuery): Promise<Page<RawErc20Transfer>>;
  getTokenMeta?(chainId: number, address: string): Promise<RawTokenMeta>;
  getNativeBalanceAt?(chainId: number, address: string, block: bigint): Promise<bigint>;
  getErc20BalanceAt?(chainId: number, address: string, token: string, block: bigint): Promise<bigint>;
  getReceipts?(chainId: number, txHashes: string[]): Promise<RawReceipt[]>;
}

/**
 * normalize() output. token is an address ref, NOT tokens.id — FK resolution is a
 * DB-write concern (worker spec).
 */
export interface NormalizedEvent {
  chainId: number;
  txHash: string; // lowercase
  logIndex: number; // ≥0 log | −1 native | −2 gas (ADR-005)
  token: { kind: 'native' } | { kind: 'erc20'; contract: string };
  eventKind: 'erc20_transfer' | 'native_transfer' | 'gas_fee';
  fromAddr: string; // lowercase
  toAddr: string; // lowercase; gas_fee → zero address
  amountRaw: bigint; // ADR-004: never number
  blockNumber: bigint;
  blockTime: Date;
  provider: string;
}

export type ProviderErrorKind = 'http' | 'rate_limited' | 'malformed' | 'provider_error';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

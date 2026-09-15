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

/**
 * A contract-initiated native value transfer (`txlistinternal`). No gas fields — the
 * fee is charged once on the parent tx (already captured as its `gas_fee`). `to` is
 * nullable for internal contract creations, which move no value and are skipped.
 */
export interface RawInternalTx {
  blockNumber: string;
  timeStamp: string;
  hash: string; // parent tx hash
  from: string;
  to: string | null;
  value: string;
  isError: '0' | '1';
  /**
   * How the provider labels this trace's position in its parent tx: Etherscan sends a dotted
   * DFS path (`traceId`, e.g. "0_1_2"), Blockscout a plain ordinal (`index`, e.g. "67").
   * Optional — a provider may send neither.
   *
   * **Audit payload, not an ordering key.** Until 2026-09-15 `normalize()` ranked on this
   * before assigning the −(1000+n) sentinels; it no longer does, because the sentinel is half
   * an idempotency key and a label is how a provider chose to NAME a row rather than what the
   * row is (ADR-005 d2). Ranking is now `(from, to, value)`, full stop. The Blockscout half of
   * the old claim was never verifiable anyway: in the smaller of the two captured fixtures
   * with rows, five SINGLE-trace transactions carry `index` 67, 81, 161, 98 and 17 — which is
   * not a per-tx ordinal.
   *
   * Its only consumer is `chain_events.raw`, and nothing in `src/` reads it back. That is
   * deliberate, not neglect: it is what makes "deleting the label path does not lose the
   * label" true, and it is pinned by processors.itest.ts ("keeps the provider trace label in
   * chain_events.raw"). Do not remove it as dead code without reading that test first.
   */
  traceId?: string | undefined;
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
  // Contract-initiated native value moves (`txlistinternal`), fetched by the worker's
  // `native` stream alongside txlist over the same window (processors/ingest.ts). Closes
  // the R3 gap where txlist alone omits them, so a native balance reconciles to
  // eth_get_balance to the wei (04-testing.md §2, ADR-005 d2). Optional capability
  // (ADR-009): both shipping adapters implement it and failoverProvider forwards it, but
  // a chain served by neither degrades to txlist-only rather than failing every page.
  getInternalTxs?(q: PageQuery): Promise<Page<RawInternalTx>>;
  getErc20Transfers(q: PageQuery): Promise<Page<RawErc20Transfer>>;
  getTokenMeta?(chainId: number, address: string): Promise<RawTokenMeta>;
  getNativeBalanceAt?(chainId: number, address: string, block: bigint): Promise<bigint>;
  getErc20BalanceAt?(chainId: number, address: string, token: string, block: bigint): Promise<bigint>;
  getReceipts?(chainId: number, txHashes: string[]): Promise<RawReceipt[]>;
  // Anchoring (ADR-008): resolve a date's unix timestamp → the last block at or
  // before it, so anchored coverage starts on a real block. Free-tier on both
  // providers (getblocknobytime), unlike balance-at-block.
  getBlockByTime?(chainId: number, unixSeconds: number): Promise<bigint>;
  // >50k probe (ADR-008 Q5): a cheap, best-effort transaction-count estimate. A
  // lower bound is fine — it only drives the anchored *suggestion* (HITL).
  estimateTxCount?(chainId: number, address: string): Promise<number>;
}

/**
 * normalize() output. token is an address ref, NOT tokens.id — FK resolution is a
 * DB-write concern (worker spec).
 */
export interface NormalizedEvent {
  chainId: number;
  txHash: string; // lowercase
  logIndex: number; // ≥0 log | −1 native | −2 gas (ADR-005)
  token:
    | { kind: 'native' }
    | { kind: 'erc20'; contract: string; decimals: string; symbolRaw: string; nameRaw: string };
  eventKind: 'erc20_transfer' | 'native_transfer' | 'gas_fee';
  fromAddr: string; // lowercase
  toAddr: string; // lowercase; gas_fee → zero address
  amountRaw: bigint; // ADR-004: never number
  blockNumber: bigint;
  blockTime: Date;
  provider: string;
  txFrom: string; // lowercase; tx-level sender
  txTo: string | null; // lowercase; null on contract creation
  raw: unknown; // source provider row → chain_events.raw (server-side only, NOT NULL)
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

/**
 * The requested `anchor_from` date resolves to a block inside the reorg-unsafe
 * tip (`resolved > safeHead`, ADR-005 finality / ADR-008 amendment). Clamping to
 * safeHead — the prior behavior — fetched the provider-attested balance there
 * but stamped the `opening_balance` event's `block_time` at midnight-of-anchor-
 * date, a block/time mismatch that breaks the monotonicity `ledger/src/as-of.ts`
 * assumes and silently folds every deposit between the anchor date and safeHead
 * into the "as of anchor date" balance. Rejected loudly instead (H8). Carries
 * only the numeric finalityDepth — no provider text (ADR-011).
 */
export class AnchorTooRecentError extends Error {
  readonly finalityDepth: number;

  constructor(finalityDepth: number) {
    super(`anchor date too recent: must be at least ${String(finalityDepth)} blocks old`);
    this.name = 'AnchorTooRecentError';
    this.finalityDepth = finalityDepth;
  }
}

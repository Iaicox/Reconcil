/**
 * Ledger domain types. Money crosses the public surface as strings (raw base
 * units) plus a scaled `DecimalString` (ADR-004); internally the folds operate
 * on `bigint`. Ledger is tenant-agnostic: scope is an explicit address set, and
 * tenant→wallet resolution lives above (mcp-tools/db).
 */
import type { DecimalString } from '@pet-crypto/core';

export type EventKind = 'native_transfer' | 'erc20_transfer' | 'gas_fee' | 'opening_balance';

/** Max backing event refs carried inline before summarizing (C3, contracts §3). */
export const EVENT_REF_CAP = 64;

/** A set of addresses to compute over; tenant→address resolution is above ledger. */
export interface LedgerScope {
  addresses: string[];
  chainIds?: number[];
}

/** Points at one backing event for citations (C1/C3). */
export interface EventRef {
  chainId: number;
  txHash: string;
  logIndex: number;
}

/** Backing events for one aggregate: inline refs (≤ EVENT_REF_CAP) + full count. */
export interface BackingEvents {
  refs: EventRef[];
  totalCount: number;
  capped: boolean;
}

/** Sanitized token facts safe for tool responses (never *_raw hostile strings). */
export interface TokenMeta {
  tokenId: number;
  chainId: number;
  address: string | null; // null = native
  symbolDisplay: string | null;
  decimals: number;
  verified: boolean;
  isStablecoin: boolean;
  pegCurrency: string | null;
}

/** Per-chain resolved as-of anchor echoed back to the caller (citable). */
export interface AsOfResolved {
  chainId: number;
  block: number | null;
  date: string; // ISO date (UTC)
}

export interface BalancesParams {
  scope: LedgerScope;
  asOf?: string; // ISO date (UTC); default: latest finalized ingested
  includeUnverified?: boolean; // default false (spam filter)
}

export interface BalanceRow {
  address: string;
  chainId: number;
  token: TokenMeta;
  amountRaw: string;
  amount: DecimalString;
  backing: BackingEvents;
}

export interface BalancesResult {
  asOf: AsOfResolved[];
  rows: BalanceRow[];
}

/** Inclusive ISO date range (UTC): `[from, to]` whole days. */
export interface Period {
  from: string;
  to: string;
}

export type FlowDirection = 'in' | 'out' | 'both';

/**
 * Flow grouping dimensions. `token` is always applied — raw inflow/outflow are
 * base-unit sums, meaningful only per token (ADR-004) — so the others *subdivide*
 * a token's flow rather than replace it.
 */
export type FlowGroupBy = 'token' | 'counterparty' | 'day' | 'month';

export interface FlowsParams {
  scope: LedgerScope;
  period: Period;
  chainIds?: number[];
  direction?: FlowDirection; // default 'both'
  includeUnverified?: boolean; // default false
  restrictTokenIds?: number[]; // internal: narrow to a token-id set (stablecoins)
  groupBy?: FlowGroupBy[]; // default ['token']; 'token' is always applied
}

export interface StablecoinParams {
  scope: LedgerScope;
  period: Period;
  pegCurrency?: 'USD' | 'EUR';
  chainIds?: number[];
  direction?: FlowDirection;
  groupBy?: FlowGroupBy[]; // forwarded to computeFlows; tool boundary restricts to token/counterparty/month
}

export interface FlowRow {
  tokenId: number;
  token: TokenMeta;
  group: Record<string, string>;
  inflowRaw: string;
  inflow: DecimalString;
  outflowRaw: string;
  outflow: DecimalString;
  netRaw: string;
  net: DecimalString; // signed: inflow − outflow
  txCount: number;
  backing: BackingEvents;
}

export interface FlowsResult {
  rows: FlowRow[]; // external flows, one per token
  internal: FlowRow[]; // self-transfers between two in-scope wallets
}

/**
 * Gas grouping. `chain` is always applied (the native fee token is per-chain, so
 * raw sums are meaningful only per chain — cf. `token` in flows); `wallet` (payer)
 * and `month` subdivide.
 */
export type GasGroupBy = 'wallet' | 'chain' | 'month';

export interface GasParams {
  scope: LedgerScope;
  period: Period;
  chainIds?: number[];
  groupBy?: GasGroupBy[]; // default ['chain']; 'chain' is always applied
}

export interface GasRow {
  chainId: number;
  tokenId: number;
  token: TokenMeta;
  group: Record<string, string>;
  nativeAmountRaw: string;
  nativeAmount: DecimalString;
  txCount: number;
  backing: BackingEvents;
}

export interface ListEventsParams {
  scope: LedgerScope;
  period?: Period;
  chainIds?: number[];
  tokens?: Array<{ chainId: number; address: string | null }>;
  counterpartyAddress?: string;
  kinds?: EventKind[];
  minAmount?: string; // display units; per-row numeric threshold
  includeUnverified?: boolean;
  cursor?: string;
  limit?: number; // ≤ 200, default 50
}

export interface EventListItem {
  chainId: number;
  txHash: string;
  logIndex: number;
  id: number;
  kind: EventKind;
  blockNumber: number;
  blockTime: string; // ISO 8601 UTC
  token: TokenMeta;
  amountRaw: string;
  amount: DecimalString;
  fromAddr: string;
  toAddr: string;
  direction: 'in' | 'out' | 'internal';
}

export interface ListEventsResult {
  events: EventListItem[];
  nextCursor?: string;
  totalCount?: number; // first page only (cursor absent); callers cache it
}

export interface CounterpartiesParams {
  scope: LedgerScope;
  period: Period;
  direction?: FlowDirection;
  topN?: number; // default 20
  includeUnverified?: boolean;
  chainIds?: number[];
}

export interface CounterpartyTokenTurnover {
  token: TokenMeta;
  inflowRaw: string;
  inflow: DecimalString;
  outflowRaw: string;
  outflow: DecimalString;
}

export interface CounterpartyRow {
  address: string; // raw counterparty; labeling lives above ledger
  perToken: CounterpartyTokenTurnover[];
  tokens: TokenMeta[];
  txCount: number;
  backing: BackingEvents;
}

export interface CounterpartiesResult {
  rows: CounterpartyRow[];
  totalCounterparties: number;
  truncatedCount: number;
}

export interface StatusParams {
  addresses: string[];
  chainIds?: number[];
  freshnessThresholdSec?: number; // default 3600
}

export interface StreamStatus {
  stream: 'native' | 'erc20';
  status: string;
  lastProcessedBlock: number;
  lastBlockTime?: string; // ISO 8601 UTC
  anchorBlock?: number;
  backfillProgress?: number; // 0..1 estimate; omitted when unknown
  lastError?: string;
  stale: boolean;
}

export interface WalletCoverage {
  address: string;
  chainId: number;
  anchored: boolean;
  streams: StreamStatus[];
  integrity?: unknown; // provider-vs-computed drift check (already scrubbed)
}

/** The subset of `chain_events` columns the ledger folds and SQL builders read. */
export interface LedgerEvent {
  chainId: number;
  txHash: string;
  logIndex: number;
  eventKind: EventKind;
  tokenId: number;
  amountRaw: bigint;
  fromAddr: string;
  toAddr: string;
  blockNumber: number;
  blockTime: Date;
}

/** Inclusive time window `[from, to]` (mirrors SQL `block_time BETWEEN`). */
export interface TimeWindow {
  from?: Date;
  to?: Date;
}

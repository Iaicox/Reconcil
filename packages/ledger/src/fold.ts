/**
 * Pure in-memory reference model over an event array — the oracle the SQL
 * builders are property-tested against (SQL ≡ fold), and the definition of
 * every aggregation's semantics. No I/O, no scaling: folds work on `bigint`
 * base units; scaling to `DecimalString` happens once at the edge (ADR-004).
 *
 * Direction relative to a scope set S: inbound `to∈S ∧ from∉S`, outbound
 * `from∈S ∧ to∉S`, internal `from∈S ∧ to∈S`. Gas (`to=0x0∉S`) is always
 * outbound. Balance = Σ[to∈S] − Σ[from∈S] over all event kinds.
 */
import type { LedgerEvent, TimeWindow } from './types.js';

const TRANSFER_KINDS = new Set<LedgerEvent['eventKind']>(['native_transfer', 'erc20_transfer']);

function inWindow(ev: LedgerEvent, w?: TimeWindow): boolean {
  if (!w) return true;
  const t = ev.blockTime.getTime();
  if (w.from && t < w.from.getTime()) return false;
  if (w.to && t > w.to.getTime()) return false;
  return true;
}

function add(m: Map<string, Map<number, bigint>>, addr: string, tokenId: number, delta: bigint): void {
  let inner = m.get(addr);
  if (!inner) { inner = new Map(); m.set(addr, inner); }
  inner.set(tokenId, (inner.get(tokenId) ?? 0n) + delta);
}

/**
 * Net balance per (address, tokenId) for addresses in `scope`, over events with
 * `blockTime ≤ asOf` (all history when `asOf` is omitted). Includes internal
 * transfers and `opening_balance` anchors; gas subtracts (from∈S, to=0x0).
 */
export function foldBalances(
  events: LedgerEvent[],
  scope: Iterable<string>,
  asOf?: Date,
): Map<string, Map<number, bigint>> {
  const S = new Set(scope);
  const asOfMs = asOf?.getTime();
  const out = new Map<string, Map<number, bigint>>();
  for (const ev of events) {
    if (asOfMs !== undefined && ev.blockTime.getTime() > asOfMs) continue;
    if (S.has(ev.toAddr)) add(out, ev.toAddr, ev.tokenId, ev.amountRaw);
    if (S.has(ev.fromAddr)) add(out, ev.fromAddr, ev.tokenId, -ev.amountRaw);
  }
  return out;
}

export interface FlowAgg {
  inflow: bigint;
  outflow: bigint;
  txHashes: Set<string>;
}

export interface FlowsFold {
  externalByToken: Map<number, FlowAgg>;
  internalByToken: Map<number, FlowAgg>;
}

function agg(m: Map<number, FlowAgg>, tokenId: number): FlowAgg {
  let a = m.get(tokenId);
  if (!a) { a = { inflow: 0n, outflow: 0n, txHashes: new Set() }; m.set(tokenId, a); }
  return a;
}

/**
 * External inflow/outflow and internal volume per token, over transfer events
 * (excludes `gas_fee` and `opening_balance`) within `window`. Self-transfers
 * between two in-scope wallets are the `internalByToken` bucket, never external.
 */
export function foldFlows(events: LedgerEvent[], scope: Iterable<string>, window?: TimeWindow): FlowsFold {
  const S = new Set(scope);
  const externalByToken = new Map<number, FlowAgg>();
  const internalByToken = new Map<number, FlowAgg>();
  for (const ev of events) {
    if (!TRANSFER_KINDS.has(ev.eventKind)) continue;
    if (!inWindow(ev, window)) continue;
    const fromIn = S.has(ev.fromAddr);
    const toIn = S.has(ev.toAddr);
    if (fromIn && toIn) {
      const a = agg(internalByToken, ev.tokenId);
      a.inflow += ev.amountRaw;
      a.outflow += ev.amountRaw;
      a.txHashes.add(ev.txHash);
    } else if (toIn) {
      const a = agg(externalByToken, ev.tokenId);
      a.inflow += ev.amountRaw;
      a.txHashes.add(ev.txHash);
    } else if (fromIn) {
      const a = agg(externalByToken, ev.tokenId);
      a.outflow += ev.amountRaw;
      a.txHashes.add(ev.txHash);
    }
  }
  return { externalByToken, internalByToken };
}

export interface CpAgg {
  inflow: bigint; // amount the scope received from this counterparty
  outflow: bigint; // amount the scope sent to this counterparty
  txHashes: Set<string>;
}

/**
 * Turnover per counterparty (the non-scope endpoint) per token, over external
 * transfers (excludes gas/opening and internal self-transfers) within `window`.
 * inflow/outflow are scope-relative (received-from / sent-to). Labeling of the
 * counterparty address lives above ledger.
 */
export function foldCounterparties(
  events: LedgerEvent[],
  scope: Iterable<string>,
  window?: TimeWindow,
): Map<string, Map<number, CpAgg>> {
  const S = new Set(scope);
  const out = new Map<string, Map<number, CpAgg>>();
  const cell = (cp: string, tokenId: number): CpAgg => {
    let byToken = out.get(cp);
    if (!byToken) { byToken = new Map(); out.set(cp, byToken); }
    let a = byToken.get(tokenId);
    if (!a) { a = { inflow: 0n, outflow: 0n, txHashes: new Set() }; byToken.set(tokenId, a); }
    return a;
  };
  for (const ev of events) {
    if (!TRANSFER_KINDS.has(ev.eventKind)) continue;
    if (!inWindow(ev, window)) continue;
    const fromIn = S.has(ev.fromAddr);
    const toIn = S.has(ev.toAddr);
    if (fromIn && toIn) continue; // internal
    if (toIn) {
      const a = cell(ev.fromAddr, ev.tokenId);
      a.inflow += ev.amountRaw;
      a.txHashes.add(ev.txHash);
    } else if (fromIn) {
      const a = cell(ev.toAddr, ev.tokenId);
      a.outflow += ev.amountRaw;
      a.txHashes.add(ev.txHash);
    }
  }
  return out;
}

/** Gas spend per token (native) for owned senders within `window`. */
export function foldGas(
  events: LedgerEvent[],
  scope: Iterable<string>,
  window?: TimeWindow,
): Map<number, { amount: bigint; txCount: number }> {
  const S = new Set(scope);
  const out = new Map<number, { amount: bigint; txCount: number }>();
  for (const ev of events) {
    if (ev.eventKind !== 'gas_fee') continue;
    if (!S.has(ev.fromAddr)) continue;
    if (!inWindow(ev, window)) continue;
    const cur = out.get(ev.tokenId) ?? { amount: 0n, txCount: 0 };
    cur.amount += ev.amountRaw;
    cur.txCount += 1;
    out.set(ev.tokenId, cur);
  }
  return out;
}

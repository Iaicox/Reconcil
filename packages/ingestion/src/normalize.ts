import type {
  NormalizedEvent,
  Page,
  RawInternalTx,
  RawNativeTx,
  RawReceipt,
} from './types.js';
import type { Erc20WithMeta } from './logindex.js';

/** Trace-level internal transfer n → sentinel log_index (ADR-005 d2). */
const INTERNAL_SENTINEL_BASE = -1000;

/**
 * Order two traces of the same parent tx by the provider's trace label. Etherscan
 * sends a dotted DFS path ("0", "0_1", "0_10"), Blockscout a plain ordinal ("67");
 * both compare component-wise and numerically, so "0_2" precedes "0_10" (a lexical
 * sort would invert them) and a shorter path precedes its own extensions. A
 * non-numeric component falls back to text order — an unknown labelling scheme
 * still yields a total, deterministic order, which is all the caller needs.
 */
function compareTraceIds(a: string, b: string): number {
  const pa = a.split('_');
  const pb = b.split('_');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    if (xa === xb) continue;
    const na = Number(xa);
    const nb = Number(xb);
    if (Number.isInteger(na) && Number.isInteger(nb) && na !== nb) return na < nb ? -1 : 1;
    if (!Number.isInteger(na) || !Number.isInteger(nb)) return xa < xb ? -1 : 1;
  }
  return 0;
}

/** An internal row that actually moves value, tagged with its position in the page. */
interface InternalValueMove {
  it: RawInternalTx & { to: string };
  arrival: number;
}

/**
 * Trace-id-free fallback order: (from, to, value), lowercased so a provider's
 * address casing cannot change the answer. Ties (two byte-identical traces in one
 * tx) are broken by arrival order at the call site.
 */
function compareTraceTuple(a: RawInternalTx, b: RawInternalTx): number {
  const fa = a.from.toLowerCase();
  const fb = b.from.toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  const ta = (a.to ?? '').toLowerCase();
  const tb = (b.to ?? '').toLowerCase();
  if (ta !== tb) return ta < tb ? -1 : 1;
  const va = BigInt(a.value);
  const vb = BigInt(b.value);
  if (va !== vb) return va < vb ? -1 : 1;
  return 0;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface NormalizeContext {
  chainId: number;
  trackedAddress: string;
  feeStrategy: 'txlist' | 'receipts-opstack';
  provider: string;
  /** keyed by lowercase tx hash; required for outgoing txs under receipts-opstack */
  receipts?: ReadonlyMap<string, RawReceipt>;
}

/**
 * Pure canonicalization (spec §8): lowercase, bigint, kind mapping, gas synthesis.
 * Cross-page dedup is the DB idempotency key's job (ADR-005) — not done here.
 */
export function normalize(
  input: {
    native?: Page<RawNativeTx> | undefined;
    internal?: Page<RawInternalTx> | undefined;
    erc20?: Page<Erc20WithMeta> | undefined;
  },
  ctx: NormalizeContext,
): NormalizedEvent[] {
  const tracked = ctx.trackedAddress.toLowerCase();
  const events: NormalizedEvent[] = [];

  for (const tx of input.native?.items ?? []) {
    const from = tx.from.toLowerCase();
    const toAddr = tx.to === null ? ZERO_ADDRESS : tx.to.toLowerCase();
    const txFrom = from; // tx-level sender = row.from
    const txTo = tx.to === null ? null : tx.to.toLowerCase();
    const common = {
      chainId: ctx.chainId,
      txHash: tx.hash.toLowerCase(),
      token: { kind: 'native' } as const,
      blockNumber: BigInt(tx.blockNumber),
      blockTime: new Date(Number(tx.timeStamp) * 1000),
      provider: ctx.provider,
      txFrom,
      txTo,
      raw: tx,
    };

    // Failed txs move no value — but the gas below is still real.
    if (tx.isError === '0' && BigInt(tx.value) > 0n) {
      events.push({
        ...common,
        logIndex: -1,
        eventKind: 'native_transfer',
        fromAddr: from,
        toAddr,
        amountRaw: BigInt(tx.value),
      });
    }

    if (from === tracked) {
      events.push({
        ...common,
        logIndex: -2,
        eventKind: 'gas_fee',
        fromAddr: from,
        toAddr: ZERO_ADDRESS,
        amountRaw: gasFee(tx, ctx),
      });
    }
  }

  // Internal transfers (txlistinternal): contract-initiated native value moves that
  // txlist omits. No gas of their own (the parent tx's gas_fee covers it). Several can
  // share one parent tx, so each gets sentinel −(1000+n) (ADR-005 d2). Failed /
  // zero-value / contract-creation rows move no value → skipped, and consume no slot.
  //
  // n is the trace's RANK inside its parent tx under a stable order — the provider's
  // trace label when it sends one (Etherscan `traceId`, Blockscout `index`), else a
  // (from, to, value) tuple — never arrival order. The append-only idempotency key
  // (chain_id, tx_hash, log_index, token_id) therefore depends only on the row set, so
  // the same tx re-fetched (the overlap-by-one boundary block, or the same window
  // served by the other provider after a failover) re-derives the same keys and ON
  // CONFLICT DO NOTHING dedupes it. Arrival-order numbering would renumber the traces
  // into each other's slots and silently drop a real value movement.
  //
  // Two residual caveats, both accepted:
  //  - two byte-identical traces in one tx (same from/to/value) with no trace label tie,
  //    and fall back to the provider's response order among the ties;
  //  - a provider page that ends mid-tx stores a PREFIX of that tx's traces. Their keys
  //    match the whole-tx re-fetch only because the truncation is a prefix of the
  //    provider's order and the trace label agrees with it; the tuple fallback trades
  //    that for order-independence. Both shipping providers send a label, so the
  //    fallback is defensive only — and the cursor always overlaps the boundary block
  //    (processors/ingest.ts), so the tx is always re-fetched whole afterwards.
  //
  // Emission stays in arrival order; only the sentinel comes from the rank.
  const internalRows: InternalValueMove[] = (input.internal?.items ?? [])
    .map((it, arrival) => ({ it, arrival }))
    .filter(
      (r): r is InternalValueMove =>
        r.it.isError === '0' && r.it.to !== null && BigInt(r.it.value) > 0n,
    );
  const byParentTx = new Map<string, InternalValueMove[]>();
  for (const row of internalRows) {
    const txHash = row.it.hash.toLowerCase();
    const group = byParentTx.get(txHash);
    if (group) group.push(row);
    else byParentTx.set(txHash, [row]);
  }
  const sentinelRank = new Map<number, number>(); // arrival index → n
  for (const group of byParentTx.values()) {
    // Per group: label order iff every trace in it carries a label (one page comes
    // from one provider, so a mixed group is not a real shape — but be explicit).
    const labelled = group.every(({ it }) => (it.traceId ?? '') !== '');
    [...group]
      .sort((a, b) => {
        const primary = labelled
          ? compareTraceIds(a.it.traceId ?? '', b.it.traceId ?? '')
          : compareTraceTuple(a.it, b.it);
        return primary !== 0 ? primary : a.arrival - b.arrival;
      })
      .forEach((row, n) => sentinelRank.set(row.arrival, n));
  }

  for (const { it, arrival } of internalRows) {
    const txHash = it.hash.toLowerCase();
    const n = sentinelRank.get(arrival) ?? 0;
    events.push({
      chainId: ctx.chainId,
      txHash,
      logIndex: INTERNAL_SENTINEL_BASE - n,
      eventKind: 'native_transfer',
      token: { kind: 'native' },
      fromAddr: it.from.toLowerCase(),
      toAddr: it.to.toLowerCase(),
      amountRaw: BigInt(it.value),
      blockNumber: BigInt(it.blockNumber),
      blockTime: new Date(Number(it.timeStamp) * 1000),
      provider: ctx.provider,
      // tx-level from/to mirror the internal endpoints — chain_events.tx_from/tx_to are
      // NOT NULL and an internal transfer has no distinct outer tx envelope here. So
      // counterparty/initiator analytics over an internal inflow see the internal sender
      // (the contract that sent the value), not the outer tx's originator. For an inflow
      // that internal sender IS the meaningful counterparty, so this is a deliberate choice,
      // not a misattribution; a txlist⋈txlistinternal join could recover the outer
      // originator if initiator-level analytics ever need it (follow-up, not needed today).
      txFrom: it.from.toLowerCase(),
      txTo: it.to.toLowerCase(),
      raw: it,
    });
  }

  for (const t of input.erc20?.items ?? []) {
    // Peel off the receipt-derived fields so `raw` holds the untouched provider
    // row (its documented contract) — logIndex/txFrom/txTo are already first-class
    // columns, not part of the source payload.
    const { logIndex, txFrom, txTo, ...rawRow } = t;
    events.push({
      chainId: ctx.chainId,
      txHash: t.hash.toLowerCase(),
      logIndex: Number(logIndex),
      eventKind: 'erc20_transfer',
      token: {
        kind: 'erc20',
        contract: t.contractAddress.toLowerCase(),
        decimals: t.tokenDecimal,
        symbolRaw: t.tokenSymbol,
        nameRaw: t.tokenName,
      },
      fromAddr: t.from.toLowerCase(),
      toAddr: t.to.toLowerCase(),
      amountRaw: BigInt(t.value),
      blockNumber: BigInt(t.blockNumber),
      blockTime: new Date(Number(t.timeStamp) * 1000),
      provider: ctx.provider,
      txFrom,
      txTo,
      raw: rawRow,
    });
  }

  return events;
}

function gasFee(tx: RawNativeTx, ctx: NormalizeContext): bigint {
  if (ctx.feeStrategy === 'txlist') {
    return BigInt(tx.gasUsed) * BigInt(tx.gasPrice);
  }
  const receipt = ctx.receipts?.get(tx.hash.toLowerCase());
  if (!receipt) {
    throw new Error('missing receipt for outgoing tx — receipts-opstack requires receipts before normalize()', {
      cause: tx.hash.toLowerCase(),
    });
  }
  const l2 = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  return receipt.l1Fee === null ? l2 : l2 + BigInt(receipt.l1Fee);
}

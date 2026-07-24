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
  input: { native?: Page<RawNativeTx>; internal?: Page<RawInternalTx>; erc20?: Page<Erc20WithMeta> },
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
  // share one parent tx, so each gets sentinel −(1000+n), n = 0-based emit order per tx
  // (ADR-005 d2). Failed / zero-value / contract-creation rows move no value → skipped.
  const internalSeen = new Map<string, number>();
  for (const it of input.internal?.items ?? []) {
    if (it.isError !== '0' || it.to === null || BigInt(it.value) <= 0n) continue;
    const txHash = it.hash.toLowerCase();
    const n = internalSeen.get(txHash) ?? 0;
    internalSeen.set(txHash, n + 1);
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

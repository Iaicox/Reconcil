import type {
  NormalizedEvent,
  Page,
  RawErc20Transfer,
  RawNativeTx,
  RawReceipt,
} from './types.js';

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
  input: { native?: Page<RawNativeTx>; erc20?: Page<RawErc20Transfer> },
  ctx: NormalizeContext,
): NormalizedEvent[] {
  const tracked = ctx.trackedAddress.toLowerCase();
  const events: NormalizedEvent[] = [];

  for (const tx of input.native?.items ?? []) {
    const from = tx.from.toLowerCase();
    const toAddr = tx.to === null ? ZERO_ADDRESS : tx.to.toLowerCase();
    const common = {
      chainId: ctx.chainId,
      txHash: tx.hash.toLowerCase(),
      token: { kind: 'native' } as const,
      blockNumber: BigInt(tx.blockNumber),
      blockTime: new Date(Number(tx.timeStamp) * 1000),
      provider: ctx.provider,
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

  for (const t of input.erc20?.items ?? []) {
    if (t.logIndex === null) {
      throw new Error(
        `missing logIndex for erc20 transfer in tx ${t.hash.toLowerCase()} — resolve spec §11 before ingesting`,
      );
    }
    events.push({
      chainId: ctx.chainId,
      txHash: t.hash.toLowerCase(),
      logIndex: Number(t.logIndex),
      eventKind: 'erc20_transfer',
      token: { kind: 'erc20', contract: t.contractAddress.toLowerCase() },
      fromAddr: t.from.toLowerCase(),
      toAddr: t.to.toLowerCase(),
      amountRaw: BigInt(t.value),
      blockNumber: BigInt(t.blockNumber),
      blockTime: new Date(Number(t.timeStamp) * 1000),
      provider: ctx.provider,
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
    throw new Error(
      `missing receipt for outgoing tx ${tx.hash.toLowerCase()} — receipts-opstack requires receipts before normalize()`,
    );
  }
  const l2 = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  return receipt.l1Fee === null ? l2 : l2 + BigInt(receipt.l1Fee);
}

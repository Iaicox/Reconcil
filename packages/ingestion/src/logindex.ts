/**
 * Receipt-derived erc20 logIndex + tx-level from/to (spec §11, resolution option
 * 3). No provider returns logIndex in tokentx; the receipt's Transfer logs carry
 * the exact, provider-independent index. Match by (contract, from, to, value),
 * consuming logs in ascending logIndex so duplicate identical transfers get
 * distinct indexes. Missing receipt / unmatched row throws — synthetic ordinals
 * (option 4) stay rejected. Pure: no I/O.
 */
import type { RawErc20Transfer, RawLog, RawReceipt } from './types.js';

export interface Erc20WithMeta extends RawErc20Transfer {
  logIndex: string;
  txFrom: string;
  txTo: string | null;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddr = (topic: string): string => ('0x' + topic.slice(-40)).toLowerCase();

export function assignErc20Metadata(
  rows: RawErc20Transfer[],
  receiptsByHash: ReadonlyMap<string, RawReceipt>,
): Erc20WithMeta[] {
  // Group rows per tx so we consume each receipt's logs independently.
  const consumedByHash = new Map<string, Set<number>>();

  return rows.map((r) => {
    const hash = r.hash.toLowerCase();
    const receipt = receiptsByHash.get(hash);
    if (!receipt) throw new Error('missing receipt for erc20 transfer', { cause: hash });

    const consumed = consumedByHash.get(hash) ?? new Set<number>();
    consumedByHash.set(hash, consumed);

    const candidates = receipt.logs
      .filter(
        (l): l is RawLog =>
          l.topics.length === 3 &&
          l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
          l.address === r.contractAddress.toLowerCase() &&
          !consumed.has(l.logIndex),
      )
      .sort((a, b) => a.logIndex - b.logIndex);

    const from = r.from.toLowerCase();
    const to = r.to.toLowerCase();
    const value = BigInt(r.value);
    const match = candidates.find(
      (l) => topicAddr(l.topics[1]!) === from && topicAddr(l.topics[2]!) === to && BigInt(l.data) === value,
    );
    if (!match) throw new Error('no matching Transfer log for erc20 transfer', { cause: hash });

    consumed.add(match.logIndex);
    return { ...r, logIndex: String(match.logIndex), txFrom: receipt.from, txTo: receipt.to };
  });
}

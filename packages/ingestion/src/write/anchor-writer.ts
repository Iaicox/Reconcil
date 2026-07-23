/**
 * Opening-balance rows for anchored-window backfill (ADR-008, 03-ingestion §3).
 * `opening_balance` events are SYNTHESIZED from a provider-attested balance, not
 * derived from a provider page, so they are built here as chain_events insert
 * rows directly (NormalizedEvent deliberately excludes the kind). One event per
 * token, all sharing one synthetic slot (`anchor:<addr>:<block>`, log_index -3);
 * the per-`token_id` idempotency key (ADR-005) keeps them distinct. The wallet is
 * the `to` side (fold credits `to∈S`), the zero address the `from` — the mirror
 * of a gas_fee. The append-only insert path is `insertEventRows` (event-writer).
 */
import { chainEvents } from '@pet-crypto/db';
import { ZERO_ADDRESS } from '../normalize.js';

/** Provider-attested balance of one token at the anchor block. */
export interface OpeningBalance {
  tokenId: number;
  amountRaw: bigint;
  provider: string;
}

/** The synthetic, non-hex tx_hash that slots every opening_balance of one anchor. */
export function anchorTxHash(address: string, block: number): string {
  return `anchor:${address.toLowerCase()}:${String(block)}`;
}

export function buildOpeningBalanceRows(params: {
  chainId: number;
  address: string;
  block: number;
  blockTime: Date;
  balances: OpeningBalance[];
}): (typeof chainEvents.$inferInsert)[] {
  const to = params.address.toLowerCase();
  const txHash = anchorTxHash(params.address, params.block);
  return params.balances.map((b) => ({
    chainId: params.chainId,
    txHash,
    logIndex: -3,
    eventKind: 'opening_balance',
    tokenId: b.tokenId,
    amountRaw: b.amountRaw,
    fromAddr: ZERO_ADDRESS,
    toAddr: to,
    blockNumber: params.block,
    blockTime: params.blockTime,
    txFrom: ZERO_ADDRESS,
    txTo: to,
    provider: b.provider,
    // Citation of an anchored baseline is the provider snapshot call, not a tx
    // (03-ingestion §3). Server-side only, never sent to the LLM (ADR-011).
    raw: { kind: 'anchor', block: params.block, provider: b.provider },
  }));
}

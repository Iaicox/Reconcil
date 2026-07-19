/**
 * NormalizedEvent → chain_events insert row, and a batch insert that is the ONLY
 * write path (append-only, ADR-005): INSERT … ON CONFLICT (chain_id, tx_hash,
 * log_index, token_id) DO NOTHING. blockNumber is mode 'number' (< 2^53, not
 * money); amountRaw is bigint (ADR-004).
 */
import { chainEvents, type Db } from '@pet-crypto/db';
import type { NormalizedEvent } from '../types.js';

export function toChainEventRow(ev: NormalizedEvent, tokenId: number): typeof chainEvents.$inferInsert {
  return {
    chainId: ev.chainId, txHash: ev.txHash, logIndex: ev.logIndex, eventKind: ev.eventKind,
    tokenId, amountRaw: ev.amountRaw, fromAddr: ev.fromAddr, toAddr: ev.toAddr,
    blockNumber: Number(ev.blockNumber), blockTime: ev.blockTime,
    txFrom: ev.txFrom, txTo: ev.txTo, provider: ev.provider, raw: ev.raw,
  };
}

export async function insertEventRows(db: Db, rows: (typeof chainEvents.$inferInsert)[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(chainEvents)
    .values(rows)
    .onConflictDoNothing({
      target: [chainEvents.chainId, chainEvents.txHash, chainEvents.logIndex, chainEvents.tokenId],
    })
    .returning({ id: chainEvents.id });
  return inserted.length;
}

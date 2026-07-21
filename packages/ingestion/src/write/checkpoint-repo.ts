/**
 * Checkpoint reads + the transactional page commit (03-ingestion §3): token
 * resolution, event insert, and cursor advance in one Postgres transaction — a
 * crash mid-page re-runs the page for free (idempotency key dedupes).
 */
import type { ChainConfig } from '@pet-crypto/core';
import { chainEvents, ingestionCheckpoints, tokens, type Db } from '@pet-crypto/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { NormalizedEvent } from '../types.js';
import { insertEventRows, toChainEventRow } from './event-writer.js';
import { tokenInsertValues, tokenKey } from './token-repo.js';

export interface CheckpointRow {
  chainId: number; address: string; stream: 'native' | 'erc20';
  status: string; lastProcessedBlock: number;
}
export interface CommitTarget { chainId: number; address: string; stream: 'native' | 'erc20'; }

export async function getCheckpoint(
  db: Db, chainId: number, address: string, stream: 'native' | 'erc20',
): Promise<CheckpointRow | undefined> {
  const [row] = await db
    .select({
      chainId: ingestionCheckpoints.chainId, address: ingestionCheckpoints.address,
      stream: ingestionCheckpoints.stream, status: ingestionCheckpoints.status,
      lastProcessedBlock: ingestionCheckpoints.lastProcessedBlock,
    })
    .from(ingestionCheckpoints)
    .where(and(
      eq(ingestionCheckpoints.chainId, chainId),
      eq(ingestionCheckpoints.address, address),
      eq(ingestionCheckpoints.stream, stream),
    ))
    .limit(1);
  return row;
}

export async function seedCheckpoint(
  db: Db, chainId: number, address: string, stream: 'native' | 'erc20',
): Promise<void> {
  await db.insert(ingestionCheckpoints).values({ chainId, address, stream, status: 'queued' }).onConflictDoNothing();
}

export async function commitPage(
  db: Db,
  target: CommitTarget,
  events: NormalizedEvent[],
  next: { lastProcessedBlock: number; status: 'backfilling' | 'live' },
  chain: ChainConfig,
): Promise<number> {
  return db.transaction(async (tx) => {
    const cache = new Map<string, number>();
    const rows: (typeof chainEvents.$inferInsert)[] = [];
    for (const ev of events) {
      const key = tokenKey(ev);
      let tokenId = cache.get(key);
      if (tokenId === undefined) {
        const values = tokenInsertValues(ev, chain);
        await tx.insert(tokens).values(values).onConflictDoNothing({ target: [tokens.chainId, tokens.address] });
        // $inferInsert widens address to string|null|undefined; narrow to
        // string|null so the else-branch is string under exactOptionalPropertyTypes.
        const addr = values.address ?? null;
        const [t] = await tx
          .select({ id: tokens.id })
          .from(tokens)
          .where(addr === null
            ? and(eq(tokens.chainId, ev.chainId), isNull(tokens.address))
            : and(eq(tokens.chainId, ev.chainId), eq(tokens.address, addr)))
          .limit(1);
        if (!t) throw new Error('token upsert failed to resolve id');
        tokenId = t.id;
        cache.set(key, tokenId);
      }
      rows.push(toChainEventRow(ev, tokenId));
    }

    // Same idempotent insert as the standalone writer — shared so the append-only
    // conflict key (ADR-005) has one definition; runs inside this transaction.
    const inserted = await insertEventRows(tx, rows);

    await tx
      .update(ingestionCheckpoints)
      .set({ lastProcessedBlock: next.lastProcessedBlock, status: next.status, updatedAt: new Date() })
      .where(and(
        eq(ingestionCheckpoints.chainId, target.chainId),
        eq(ingestionCheckpoints.address, target.address),
        eq(ingestionCheckpoints.stream, target.stream),
      ));

    return inserted;
  });
}

/**
 * Checkpoint reads + the transactional page commit (03-ingestion §3): token
 * resolution, event insert, and cursor advance in one Postgres transaction — a
 * crash mid-page re-runs the page for free (idempotency key dedupes).
 */
import type { ChainConfig } from '@pet-crypto/core';
import { chainEvents, ingestionCheckpoints, tokens, type Db } from '@pet-crypto/db';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { NormalizedEvent } from '../types.js';
import { insertEventRows, toChainEventRow } from './event-writer.js';
import { tokenInsertValues, tokenKey } from './token-repo.js';

export type CheckpointStatus = 'queued' | 'anchoring' | 'backfilling' | 'live' | 'paused' | 'error';
export interface CheckpointRow {
  chainId: number; address: string; stream: 'native' | 'erc20';
  status: CheckpointStatus; lastProcessedBlock: number;
}
export interface CommitTarget { chainId: number; address: string; stream: 'native' | 'erc20'; }
/** An anchoring checkpoint awaiting its opening_balance baseline (ADR-008). */
export interface AnchorTarget extends CommitTarget { anchorFrom: string; }

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

/**
 * Every checkpoint still awaiting its first backfill. The worker onboarding
 * scanner enqueues one backfill page per row; the first `commitPage` flips it to
 * `backfilling`, so a row leaves this set as soon as ingestion starts.
 */
export async function listQueuedCheckpoints(db: Db): Promise<CommitTarget[]> {
  return db
    .select({
      chainId: ingestionCheckpoints.chainId,
      address: ingestionCheckpoints.address,
      stream: ingestionCheckpoints.stream,
    })
    .from(ingestionCheckpoints)
    .where(eq(ingestionCheckpoints.status, 'queued'))
    .orderBy(ingestionCheckpoints.chainId, ingestionCheckpoints.address, ingestionCheckpoints.stream);
}

/**
 * Checkpoints in the `anchoring` state (mode='anchored', written by
 * `ledger_track_wallet`) awaiting their opening_balance baseline. The worker
 * anchor scanner enqueues one anchor job per row; `commitAnchor` flips it to
 * `backfilling`, so a row leaves this set once its baseline is written.
 */
export async function listAnchoringCheckpoints(db: Db): Promise<AnchorTarget[]> {
  const rows = await db
    .select({
      chainId: ingestionCheckpoints.chainId,
      address: ingestionCheckpoints.address,
      stream: ingestionCheckpoints.stream,
      anchorFrom: ingestionCheckpoints.anchorFrom,
    })
    .from(ingestionCheckpoints)
    .where(and(eq(ingestionCheckpoints.status, 'anchoring'), isNotNull(ingestionCheckpoints.anchorFrom)))
    .orderBy(ingestionCheckpoints.chainId, ingestionCheckpoints.address, ingestionCheckpoints.stream);
  // isNotNull guarantees anchorFrom is present; `?? ''` only narrows the type.
  return rows.map((r) => ({ ...r, anchorFrom: r.anchorFrom ?? '' }));
}

/**
 * Wallets awaiting a >50k probe: freshly `queued` native streams with no hint
 * yet. Keyed per address (native row holds the per-wallet hint). Self-empties as
 * `setTxCountHint` fills the hint or the stream leaves `queued`.
 */
export async function listProbeTargets(db: Db): Promise<{ chainId: number; address: string }[]> {
  return db
    .select({ chainId: ingestionCheckpoints.chainId, address: ingestionCheckpoints.address })
    .from(ingestionCheckpoints)
    .where(and(
      eq(ingestionCheckpoints.stream, 'native'),
      eq(ingestionCheckpoints.status, 'queued'),
      isNull(ingestionCheckpoints.txCountHint),
    ))
    .orderBy(ingestionCheckpoints.chainId, ingestionCheckpoints.address);
}

/**
 * Persist the >50k probe estimate (ADR-008 Q5). Stored on the wallet's `native`
 * stream row — a per-address value, read there by `ledger_status`.
 */
export async function setTxCountHint(db: Db, chainId: number, address: string, hint: number): Promise<void> {
  await db
    .update(ingestionCheckpoints)
    .set({ txCountHint: hint, updatedAt: new Date() })
    .where(and(
      eq(ingestionCheckpoints.chainId, chainId),
      eq(ingestionCheckpoints.address, address),
      eq(ingestionCheckpoints.stream, 'native'),
    ));
}

/**
 * Write the opening_balance baseline and advance the cursor to the anchor block
 * in one transaction (ADR-008): coverage starts at `anchor_block`, and the
 * checkpoint moves `anchoring → backfilling` so the normal backfill continues
 * forward from there. Idempotent — a re-run dedupes on the append-only key.
 */
export async function commitAnchor(
  db: Db,
  target: CommitTarget,
  rows: (typeof chainEvents.$inferInsert)[],
  anchorBlock: number,
): Promise<number> {
  return db.transaction(async (tx) => {
    const inserted = await insertEventRows(tx, rows);
    await tx
      .update(ingestionCheckpoints)
      .set({
        status: 'backfilling',
        anchorBlock,
        lastProcessedBlock: anchorBlock,
        backfillStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(ingestionCheckpoints.chainId, target.chainId),
        eq(ingestionCheckpoints.address, target.address),
        eq(ingestionCheckpoints.stream, target.stream),
      ));
    return inserted;
  });
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

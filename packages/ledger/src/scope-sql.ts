/**
 * Shared drizzle WHERE fragments so every capability derives direction, period,
 * chain, and transfer-kind filters from one definition (no drift). Direction is
 * relative to a scope set S: inbound `to∈S ∧ from∉S`, outbound `from∈S ∧ to∉S`,
 * internal `from∈S ∧ to∈S`.
 */
import { chainEvents } from '@reconcil/db';
import { and, type SQL, gte, inArray, lt, notInArray, or, sql } from 'drizzle-orm';

import type { FlowDirection, Period } from './types.js';

export const TRANSFER_KINDS = ['native_transfer', 'erc20_transfer'] as const;

/**
 * Exclusive end of a UTC calendar day: the instant `date` ends and the next day
 * begins. Shared by `periodRange` and the `as_of`/balances cutoff (balances.ts)
 * so both day-boundary constructions stay in lockstep (H10 minors).
 */
export function dayEndExclusive(date: string): Date {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * Half-open day range `[from, toExclusive)`. A closed `T23:59:59.999Z` upper
 * bound silently drops any event with sub-millisecond `block_time`
 * (TIMESTAMPTZ is microsecond-precision) — unreachable with today's
 * whole-second EVM timestamps, but wrong by construction. Pair with
 * `timeBetween`, which expects this same exclusive convention.
 */
export function periodRange(p: Period): { from: Date; to: Date } {
  return { from: new Date(`${p.from}T00:00:00.000Z`), to: dayEndExclusive(p.to) };
}

export function transferKinds(): SQL {
  return inArray(chainEvents.eventKind, TRANSFER_KINDS);
}

/** `[from, toExclusive)` — half-open, matching `periodRange`'s day-boundary convention. */
export function timeBetween(from: Date, toExclusive: Date): SQL {
  return and(gte(chainEvents.blockTime, from), lt(chainEvents.blockTime, toExclusive))!;
}

export function chainFilter(chainIds?: number[]): SQL | undefined {
  return chainIds && chainIds.length > 0 ? inArray(chainEvents.chainId, chainIds) : undefined;
}

/** Exactly one endpoint in scope, restricted to the requested direction. */
export function externalCondition(addresses: string[], direction: FlowDirection): SQL {
  const toIn = inArray(chainEvents.toAddr, addresses);
  const fromIn = inArray(chainEvents.fromAddr, addresses);
  const toOut = notInArray(chainEvents.toAddr, addresses);
  const fromOut = notInArray(chainEvents.fromAddr, addresses);
  if (direction === 'in') return and(toIn, fromOut)!;
  if (direction === 'out') return and(fromIn, toOut)!;
  return or(and(toIn, fromOut), and(fromIn, toOut))!;
}

/** Both endpoints in scope (self-transfer). */
export function internalCondition(addresses: string[]): SQL {
  return and(inArray(chainEvents.toAddr, addresses), inArray(chainEvents.fromAddr, addresses))!;
}

/** The counterparty of an event = the endpoint not in scope. */
export function counterpartyExpr(addresses: string[]): SQL<string> {
  return sql<string>`case when ${inArray(chainEvents.fromAddr, addresses)} then ${chainEvents.toAddr} else ${chainEvents.fromAddr} end`;
}

/**
 * Shared drizzle WHERE fragments so every capability derives direction, period,
 * chain, and transfer-kind filters from one definition (no drift). Direction is
 * relative to a scope set S: inbound `to∈S ∧ from∉S`, outbound `from∈S ∧ to∉S`,
 * internal `from∈S ∧ to∈S`.
 */
import { chainEvents } from '@pet-crypto/db';
import { and, type SQL, gte, inArray, lte, notInArray, or, sql } from 'drizzle-orm';

import type { FlowDirection, Period } from './types.js';

export const TRANSFER_KINDS = ['native_transfer', 'erc20_transfer'] as const;

export function periodRange(p: Period): { from: Date; to: Date } {
  return { from: new Date(`${p.from}T00:00:00.000Z`), to: new Date(`${p.to}T23:59:59.999Z`) };
}

export function transferKinds(): SQL {
  return inArray(chainEvents.eventKind, TRANSFER_KINDS);
}

export function timeBetween(from: Date, to: Date): SQL {
  return and(gte(chainEvents.blockTime, from), lte(chainEvents.blockTime, to))!;
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

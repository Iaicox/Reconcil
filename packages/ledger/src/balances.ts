/**
 * Token balances per (wallet, token) as of a block, optionally filtered to
 * verified tokens. Net = Σ[to∈S] − Σ[from∈S] over `chain_events` (ADR-005),
 * aggregated raw in SQL and scaled once at the edge (ADR-004). Ledger returns
 * quantities only; valuation is layered on above (pricing → mcp-tools).
 */
import { formatUnits } from '@pet-crypto/core';
import { chainEvents, type Db } from '@pet-crypto/db';
import { and, type SQL, inArray, lte, or, sql } from 'drizzle-orm';

import { resolveAsOf } from './as-of.js';
import { bucketBacking, emptyBacking } from './backing.js';
import { loadTokenMeta } from './token-meta.js';
import type { BackingEvents, BalanceRow, BalancesParams, BalancesResult } from './types.js';

const sumRaw = sql<string>`sum(${chainEvents.amountRaw})`;

const key = (addr: string, tokenId: number): string => `${addr} ${tokenId}`;

export async function computeBalances(db: Db, p: BalancesParams): Promise<BalancesResult> {
  const addresses = p.scope.addresses.map((a) => a.toLowerCase());
  const chainIds = p.scope.chainIds;
  const cutoff = p.asOf ? new Date(`${p.asOf}T23:59:59.999Z`) : undefined;
  if (addresses.length === 0) return { asOf: [], rows: [] };

  const chainC = chainIds && chainIds.length > 0 ? inArray(chainEvents.chainId, chainIds) : undefined;
  const timeC = cutoff ? lte(chainEvents.blockTime, cutoff) : undefined;

  // Two index-friendly aggregates (chain_events_to_idx / _from_idx). An internal
  // transfer lands in both — inflow for the recipient, outflow for the sender.
  const inflow = await db
    .select({ addr: chainEvents.toAddr, tokenId: chainEvents.tokenId, sum: sumRaw })
    .from(chainEvents)
    .where(and(inArray(chainEvents.toAddr, addresses), timeC, chainC))
    .groupBy(chainEvents.toAddr, chainEvents.tokenId);
  const outflow = await db
    .select({ addr: chainEvents.fromAddr, tokenId: chainEvents.tokenId, sum: sumRaw })
    .from(chainEvents)
    .where(and(inArray(chainEvents.fromAddr, addresses), timeC, chainC))
    .groupBy(chainEvents.fromAddr, chainEvents.tokenId);

  const net = new Map<string, { address: string; tokenId: number; amount: bigint }>();
  const bump = (addr: string, tokenId: number, delta: bigint): void => {
    const cur = net.get(key(addr, tokenId));
    if (cur) cur.amount += delta;
    else net.set(key(addr, tokenId), { address: addr, tokenId, amount: delta });
  };
  for (const r of inflow) bump(r.addr, r.tokenId, BigInt(r.sum ?? '0'));
  for (const r of outflow) bump(r.addr, r.tokenId, -BigInt(r.sum ?? '0'));

  const tokenIds = [...new Set([...net.values()].map((v) => v.tokenId))];
  const metaById = await loadTokenMeta(db, tokenIds);
  const backing = await collectBacking(db, addresses, timeC, chainC);

  const rows: BalanceRow[] = [];
  for (const { address, tokenId, amount } of net.values()) {
    if (amount === 0n) continue;
    const token = metaById.get(tokenId);
    if (!token) continue;
    if (!p.includeUnverified && !token.verified) continue;
    rows.push({
      address,
      chainId: token.chainId,
      token,
      amountRaw: amount.toString(),
      amount: formatUnits(amount, token.decimals),
      backing: backing.get(key(address, tokenId)) ?? emptyBacking(),
    });
  }
  rows.sort((a, b) => a.address.localeCompare(b.address) || a.token.tokenId - b.token.tokenId);

  const asOf = await resolveAsOf(db, {
    addresses,
    ...(chainIds ? { chainIds } : {}),
    ...(cutoff ? { cutoff } : {}),
    ...(p.asOf ? { asOfDate: p.asOf } : {}),
  });
  return { asOf, rows };
}

/** Backing refs per (wallet, token): an internal transfer backs both wallets. */
async function collectBacking(
  db: Db,
  addresses: string[],
  timeC: SQL | undefined,
  chainC: SQL | undefined,
): Promise<Map<string, BackingEvents>> {
  const S = new Set(addresses);
  const evs = await db
    .select({
      chainId: chainEvents.chainId,
      txHash: chainEvents.txHash,
      logIndex: chainEvents.logIndex,
      tokenId: chainEvents.tokenId,
      fromAddr: chainEvents.fromAddr,
      toAddr: chainEvents.toAddr,
    })
    .from(chainEvents)
    .where(and(or(inArray(chainEvents.toAddr, addresses), inArray(chainEvents.fromAddr, addresses)), timeC, chainC))
    .orderBy(chainEvents.chainId, chainEvents.blockNumber, chainEvents.logIndex, chainEvents.id);
  return bucketBacking(evs, (e) => {
    const ks: string[] = [];
    if (S.has(e.toAddr)) ks.push(key(e.toAddr, e.tokenId));
    if (S.has(e.fromAddr)) ks.push(key(e.fromAddr, e.tokenId));
    return ks;
  });
}

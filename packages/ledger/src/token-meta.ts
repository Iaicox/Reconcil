/** Load sanitized token facts (never *_raw hostile strings) for a set of ids. */
import { tokens, type Db } from '@pet-crypto/db';
import { inArray } from 'drizzle-orm';

import type { TokenMeta } from './types.js';

export async function loadTokenMeta(db: Db, tokenIds: number[]): Promise<Map<number, TokenMeta>> {
  const out = new Map<number, TokenMeta>();
  if (tokenIds.length === 0) return out;
  const metas = await db
    .select({
      tokenId: tokens.id,
      chainId: tokens.chainId,
      address: tokens.address,
      symbolDisplay: tokens.symbolDisplay,
      decimals: tokens.decimals,
      verified: tokens.verified,
      isStablecoin: tokens.isStablecoin,
      pegCurrency: tokens.pegCurrency,
    })
    .from(tokens)
    .where(inArray(tokens.id, tokenIds));
  for (const m of metas) out.set(m.tokenId, m);
  return out;
}

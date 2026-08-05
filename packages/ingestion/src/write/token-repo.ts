/**
 * Minimal inline token upsert (token-resolve queue is deferred). Native is a
 * pseudo-token (address NULL); erc20 rows are verified=false with raw hostile
 * strings and NULL display until a later token-resolve slice. decimals is
 * coerced into the DDL's 0..36 CHECK — the base-unit ledger stays exact.
 *
 * The native symbol comes from chains.config.ts (a trusted constant, not an
 * on-chain string), so it is safe to also carry in symbol_display/name_display
 * (ADR-011) even though this fallback insert stays verified=false — the curated
 * seed migration (packages/db/migrations/0002_seed_curated_tokens.sql) is the
 * verified=true authority and wins this row's slot via ON CONFLICT DO NOTHING.
 */
import type { ChainConfig } from '@reconcil/core';
import { tokens } from '@reconcil/db';
import type { NormalizedEvent } from '../types.js';

export function tokenKey(ev: NormalizedEvent): string {
  return ev.token.kind === 'native' ? `native:${String(ev.chainId)}` : `${String(ev.chainId)}:${ev.token.contract}`;
}

export function tokenInsertValues(ev: NormalizedEvent, chain: ChainConfig): typeof tokens.$inferInsert {
  if (ev.token.kind === 'native') {
    return {
      chainId: ev.chainId, address: null, standard: 'native',
      symbolRaw: chain.native.symbol, nameRaw: chain.native.symbol,
      symbolDisplay: chain.native.symbol, nameDisplay: chain.native.symbol,
      decimals: chain.native.decimals, verified: false,
    };
  }
  const d = Number(ev.token.decimals);
  const decimals = Number.isInteger(d) && d >= 0 && d <= 36 ? d : 0;
  return {
    chainId: ev.chainId, address: ev.token.contract, standard: 'erc20',
    symbolRaw: ev.token.symbolRaw, nameRaw: ev.token.nameRaw,
    decimals, verified: false,
  };
}

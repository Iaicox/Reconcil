/**
 * Ledger `TokenMeta` → wire `TokenView`. Only sanitized `*_display` reaches
 * responses (C6); the raw value never leaves the server.
 *
 * FOLLOW-UP (cross-package): when `symbolDisplay` is empty the contract wants
 * `untrusted.symbol_raw_sanitized` (§6.1) and a SANITIZED_HEAVY warning — both need
 * `TokenMeta` to carry the sanitized RAW symbol + its `heavy` flag, which
 * ledger/core don't surface yet (needs a persisted heavy flag + a raw-fallback on
 * the token registry). Until then a nameless token shows `symbol: ''`.
 */
import type { TokenView } from '@pet-crypto/core';
import type { TokenMeta } from '@pet-crypto/ledger';

export function toTokenView(t: TokenMeta): TokenView {
  return {
    chain_id: t.chainId,
    address: t.address,
    symbol: t.symbolDisplay ?? '',
    decimals: t.decimals,
    is_stablecoin: t.isStablecoin,
    ...(t.pegCurrency !== null ? { peg_currency: t.pegCurrency } : {}),
    verified: t.verified,
  };
}

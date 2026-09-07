-- Curated verified-token seed (H1 remediation, docs/architecture/03-ingestion.md §7:
-- "A curated seed (natives, USDC/USDT/DAI, WETH, per chain) ships verified = true as a
-- db seed migration"). Without this, tokens.verified is never true outside eval seeds,
-- so analytics tools (include_unverified defaults to false), priceGaps (verifiedOnly
-- defaults to true), materializePegSnapshots, and anchored erc20 baselines all see an
-- empty token set on a fresh deployment.
--
-- One row per (native | USDC | USDT | DAI | WETH) for each chain in
-- packages/core/src/chains.config.ts (Ethereum=1, Base=8453 as of this migration).
-- symbol_display/name_display are trusted constants chosen by this migration, not
-- on-chain strings — safe to expose to the LLM (ADR-011). symbol_raw/name_raw are set to
-- the same trusted values for consistency with the runtime native writers
-- (packages/ingestion/src/write/token-repo.ts, packages/ingestion/src/processors/anchor.ts).
--
-- Idempotent: ON CONFLICT against the real unique index tokens_chain_id_address_key
-- (NULLS NOT DISTINCT, so the native address-NULL row dedupes too). This also means a
-- runtime writer's verified=false fallback insert for one of these tokens is a no-op —
-- the seeded verified=true row already won the slot.

-- Ethereum (chain_id 1) -------------------------------------------------------------
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (1, NULL, 'native', 'ETH', 'ETH', 'ETH', 'ETH', 18, false, NULL, true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'erc20', 'USDC', 'USD Coin', 'USDC', 'USD Coin', 6, true, 'USD', true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (1, '0xdac17f958d2ee523a2206206994597c13d831ec7', 'erc20', 'USDT', 'Tether USD', 'USDT', 'Tether USD', 6, true, 'USD', true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (1, '0x6b175474e89094c44da98b954eedeac495271d0f', 'erc20', 'DAI', 'Dai Stablecoin', 'DAI', 'Dai Stablecoin', 18, true, 'USD', true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (1, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'erc20', 'WETH', 'Wrapped Ether', 'WETH', 'Wrapped Ether', 18, false, NULL, true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint

-- Base (chain_id 8453) ----------------------------------------------------------------
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (8453, NULL, 'native', 'ETH', 'ETH', 'ETH', 'ETH', 18, false, NULL, true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'erc20', 'USDC', 'USD Coin', 'USDC', 'USD Coin', 6, true, 'USD', true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (8453, '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', 'erc20', 'USDT', 'Tether USD (Bridged)', 'USDT', 'Tether USD (Bridged)', 6, true, 'USD', true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (8453, '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', 'erc20', 'DAI', 'Dai Stablecoin', 'DAI', 'Dai Stablecoin', 18, true, 'USD', true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;
--> statement-breakpoint
INSERT INTO "tokens" ("chain_id", "address", "standard", "symbol_raw", "name_raw", "symbol_display", "name_display", "decimals", "is_stablecoin", "peg_currency", "verified")
VALUES (8453, '0x4200000000000000000000000000000000000006', 'erc20', 'WETH', 'Wrapped Ether', 'WETH', 'Wrapped Ether', 18, false, NULL, true)
ON CONFLICT ON CONSTRAINT "tokens_chain_id_address_key" DO NOTHING;

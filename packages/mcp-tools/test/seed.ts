/**
 * Shared DB seed helpers for the analytics_* integration tests. A `makeSeeder`
 * binds a running pool/db and returns concise builders (tenant, wallet, token,
 * event, checkpoint, snapshot) plus `truncate` (which also resets the tx-hash
 * sequence). Single-chain (chain_id = 1) by construction — enough for the tool
 * envelope/valuation/citation assertions these suites make.
 */
import { randomUUID } from 'node:crypto';

import { chainEvents, type Db } from '@pet-crypto/db';
import type { Pool } from 'pg';

export const TENANT = '00000000-0000-0000-0000-000000000001';
export const TENANT2 = '00000000-0000-0000-0000-000000000002';
export const OWNED = '0x00000000000000000000000000000000000000a1';
export const OWNED2 = '0x00000000000000000000000000000000000000a2';
export const EXT = '0x00000000000000000000000000000000000000e1';
export const EXT2 = '0x00000000000000000000000000000000000000e2';
export const SINK = '0x0000000000000000000000000000000000000000';

/** Wallet UUIDs are derived from the address suffix so tests can reference them. */
export const WALLET_OWNED = '00000000-0000-0000-0000-0000000000a1';
export const WALLET_OWNED2 = '00000000-0000-0000-0000-0000000000a2';

/** 18-decimal native base units. */
export const eth = (n: number): bigint => BigInt(n) * 10n ** 18n;
/** 6-decimal stablecoin base units (USDC/EURC style). */
export const stable6 = (n: number): bigint => BigInt(Math.round(n * 1e6));

export interface TokenOpts {
  decimals?: number;
  symbol?: string;
  isStablecoin?: boolean;
  pegCurrency?: string | null;
  verified?: boolean;
  address?: string | null;
}

export interface EventOpts {
  tokenId: number;
  amount: bigint;
  from: string;
  to: string;
  day?: string;
  kind?: 'native_transfer' | 'erc20_transfer' | 'gas_fee' | 'opening_balance';
}

export interface SnapshotOpts {
  currency?: string;
  source?: string;
}

export interface EntityOpts {
  id?: string;
  tenantId: string | null; // null = curated (built-in) label
  name: string;
  kind: string;
  notes?: string | null;
}

export interface EntityAddressOpts {
  entityId: string;
  tenantId: string | null; // denormalized from the parent entity
  chainId?: number | null; // null = any chain
  address: string;
}

export interface Seeder {
  truncate(): Promise<void>;
  tenant(id: string, slug: string): Promise<void>;
  wallet(id: string, tenantId: string, address: string): Promise<void>;
  token(id: number, o?: TokenOpts): Promise<void>;
  event(o: EventOpts): Promise<void>;
  checkpoint(address: string, stream: string, status: string, opts?: { anchorBlock?: number; updatedAt?: string }): Promise<void>;
  snapshot(tokenId: number, price: string, date: string, o?: SnapshotOpts): Promise<void>;
  entity(o: EntityOpts): Promise<string>; // returns the entity id
  entityAddress(o: EntityAddressOpts): Promise<void>;
}

export function makeSeeder(pool: Pool, db: Db): Seeder {
  let seq = 0;
  const logIndexOf = (kind: EventOpts['kind']): number =>
    kind === 'native_transfer' ? -1 : kind === 'gas_fee' ? -2 : kind === 'opening_balance' ? -3 : 0;

  return {
    async truncate() {
      await pool.query('TRUNCATE tenants, wallets, chain_events, tokens, price_snapshots, fx_rates, ingestion_checkpoints, tool_calls, entities, entity_addresses RESTART IDENTITY CASCADE');
      seq = 0;
    },
    async tenant(id, slug) {
      await pool.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
    },
    async wallet(id, tenantId, address) {
      await pool.query(`INSERT INTO wallets (id, tenant_id, address) VALUES ($1, $2, $3)`, [id, tenantId, address]);
    },
    async token(id, o = {}) {
      const { decimals = 18, symbol = `T${String(id)}`, isStablecoin = false, pegCurrency = null, verified = true } = o;
      const standard = o.address === null ? 'native' : 'erc20';
      const address = o.address === undefined ? `0x${id.toString(16).padStart(40, '0')}` : o.address;
      await pool.query(
        `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
         OVERRIDING SYSTEM VALUE VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, address, standard, decimals, isStablecoin, pegCurrency, verified, symbol],
      );
    },
    async event(o) {
      seq += 1;
      const kind = o.kind ?? (o.tokenId === 1 ? 'native_transfer' : 'erc20_transfer');
      await db.insert(chainEvents).values({
        chainId: 1, txHash: `0x${seq.toString(16).padStart(64, '0')}`, logIndex: logIndexOf(kind),
        eventKind: kind, tokenId: o.tokenId, amountRaw: o.amount,
        fromAddr: o.from, toAddr: o.to, blockNumber: seq, blockTime: new Date(`${o.day ?? '2026-06-15'}T12:00:00Z`),
        txFrom: o.from, txTo: o.to, provider: 'fixture', raw: {},
      });
    },
    async checkpoint(address, stream, status, opts = {}) {
      await pool.query(
        `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block, anchor_block, updated_at)
         VALUES (1, $1, $2, $3, 100, $4, $5)`,
        [address, stream, status, opts.anchorBlock ?? null, opts.updatedAt ?? new Date().toISOString()],
      );
    },
    async snapshot(tokenId, price, date, o = {}) {
      await pool.query(
        `INSERT INTO price_snapshots (token_id, price_date, currency, price, source) VALUES ($1,$2,$3,$4,$5)`,
        [tokenId, date, o.currency ?? 'USD', price, o.source ?? 'defillama'],
      );
    },
    async entity(o) {
      const id = o.id ?? randomUUID();
      await pool.query(
        `INSERT INTO entities (id, tenant_id, name, kind, notes) VALUES ($1,$2,$3,$4,$5)`,
        [id, o.tenantId, o.name, o.kind, o.notes ?? null],
      );
      return id;
    },
    async entityAddress(o) {
      await pool.query(
        `INSERT INTO entity_addresses (entity_id, tenant_id, chain_id, address) VALUES ($1,$2,$3,$4)`,
        [o.entityId, o.tenantId, o.chainId ?? null, o.address.toLowerCase()],
      );
    },
  };
}

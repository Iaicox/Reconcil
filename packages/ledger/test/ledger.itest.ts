import { createDb, runMigrations, chainEvents, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeBalances } from '../src/balances.js';
import { computeCounterparties } from '../src/counterparties.js';
import { computeFlows } from '../src/flows.js';
import { foldBalances, foldCounterparties, foldFlows, foldGas } from '../src/fold.js';
import { computeGas } from '../src/gas.js';
import { listEvents } from '../src/list-events.js';
import { periodRange } from '../src/scope-sql.js';
import { computeStablecoinMovements } from '../src/stablecoins.js';
import { getLedgerStatus } from '../src/status.js';
import type { LedgerEvent, Period, TimeWindow } from '../src/types.js';
import { arbWorld, type TokenSpec, type World } from './arbitraries.js';

const OWNED = '0x0000000000000000000000000000000000000a01';
const OWNED2 = '0x0000000000000000000000000000000000000a02';
const EXT = '0x0000000000000000000000000000000000000e01';
const NATIVE: TokenSpec = { tokenId: 1, chainId: 1, address: null, decimals: 18, standard: 'native' };
const USDC: TokenSpec = { tokenId: 2, chainId: 1, address: '0x00000000000000000000000000000000000000c2', decimals: 6, standard: 'erc20' };
const SPAM: TokenSpec = { tokenId: 3, chainId: 1, address: '0x00000000000000000000000000000000000000c3', decimals: 6, standard: 'erc20' };
const TOK0: TokenSpec = { tokenId: 4, chainId: 1, address: '0x00000000000000000000000000000000000000c4', decimals: 0, standard: 'erc20' };

const D1 = new Date('2026-01-01T00:00:00Z');
const D6 = new Date('2026-06-01T00:00:00Z');

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => { await pool.end(); await container.stop(); });

async function seedWorld(world: World, verifiedTokenIds?: Set<number>): Promise<void> {
  await pool.query('TRUNCATE chain_events, tokens RESTART IDENTITY CASCADE');
  for (const t of world.tokens) {
    const verified = verifiedTokenIds ? verifiedTokenIds.has(t.tokenId) : true;
    await pool.query(
      `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
       OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t.tokenId, t.chainId, t.address, t.standard, t.decimals, t.isStablecoin ?? false, t.pegCurrency ?? null, verified, t.standard === 'native' ? 'ETH' : `T${t.tokenId}`],
    );
  }
  const rows = world.events.map((e) => ({
    chainId: e.chainId, txHash: e.txHash, logIndex: e.logIndex, eventKind: e.eventKind,
    tokenId: e.tokenId, amountRaw: e.amountRaw, fromAddr: e.fromAddr, toAddr: e.toAddr,
    blockNumber: e.blockNumber, blockTime: e.blockTime, txFrom: e.fromAddr, txTo: e.toAddr,
    provider: 'fixture', raw: {},
  }));
  if (rows.length > 0) await db.insert(chainEvents).values(rows);
}

/** Concise event builder for hand-crafted worlds (unique tx per event). */
function events(): { push: (e: Partial<LedgerEvent> & Pick<LedgerEvent, 'eventKind' | 'tokenId' | 'amountRaw' | 'fromAddr' | 'toAddr'>) => void; list: LedgerEvent[] } {
  const list: LedgerEvent[] = [];
  return {
    list,
    push(e) {
      const i = list.length;
      const logIndex = e.eventKind === 'gas_fee' ? -2 : e.eventKind === 'native_transfer' ? -1 : e.eventKind === 'opening_balance' ? -3 : 0;
      list.push({
        chainId: e.chainId ?? 1, txHash: `0x${i.toString(16).padStart(64, '0')}`,
        logIndex: e.logIndex ?? logIndex, eventKind: e.eventKind, tokenId: e.tokenId, amountRaw: e.amountRaw,
        fromAddr: e.fromAddr, toAddr: e.toAddr, blockNumber: e.blockNumber ?? i + 1, blockTime: e.blockTime ?? D1,
      });
    },
  };
}

describe('computeBalances — SQL ≡ fold', () => {
  const worlds = fc.sample(arbWorld, { numRuns: 6, seed: 20260721 });
  worlds.forEach((world, i) => {
    it(`world #${i}: net per (wallet, token) matches foldBalances`, async () => {
      await seedWorld(world);
      const res = await computeBalances(db, { scope: { addresses: world.owned }, includeUnverified: true });

      const got = new Map(res.rows.map((r) => [`${r.address} ${r.token.tokenId}`, r.amountRaw]));
      const expected = new Map<string, string>();
      for (const [a, toks] of foldBalances(world.events, world.owned)) {
        for (const [tid, v] of toks) if (v !== 0n) expected.set(`${a} ${tid}`, v.toString());
      }
      expect(got).toEqual(expected);
    });
  });
});

describe('computeBalances — filters and semantics', () => {
  it('excludes unverified tokens by default and includes them on request', async () => {
    const e = events();
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 100n, fromAddr: EXT, toAddr: OWNED });
    e.push({ eventKind: 'erc20_transfer', tokenId: USDC.tokenId, amountRaw: 50n, fromAddr: EXT, toAddr: OWNED });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE, USDC], chainIds: [1] }, new Set([NATIVE.tokenId]));

    const filtered = await computeBalances(db, { scope: { addresses: [OWNED] } });
    expect(filtered.rows.map((r) => r.token.tokenId)).toEqual([NATIVE.tokenId]);

    const all = await computeBalances(db, { scope: { addresses: [OWNED] }, includeUnverified: true });
    expect(new Set(all.rows.map((r) => r.token.tokenId))).toEqual(new Set([NATIVE.tokenId, USDC.tokenId]));
  });

  it('honours as_of: balance reflects only events on or before the cutoff day', async () => {
    const e = events();
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 100n, fromAddr: EXT, toAddr: OWNED, blockTime: D1, blockNumber: 10 });
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 50n, fromAddr: EXT, toAddr: OWNED, blockTime: D6, blockNumber: 200 });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE], chainIds: [1] });

    const early = await computeBalances(db, { scope: { addresses: [OWNED] }, asOf: '2026-01-01' });
    expect(early.rows[0]?.amountRaw).toBe('100');
    expect(early.asOf).toEqual([{ chainId: 1, block: 10, date: '2026-01-01' }]);

    const latest = await computeBalances(db, { scope: { addresses: [OWNED] } });
    expect(latest.rows[0]?.amountRaw).toBe('150');
  });

  it('scales the display amount once at the edge (raw / 10^decimals)', async () => {
    const e = events();
    e.push({ eventKind: 'erc20_transfer', tokenId: USDC.tokenId, amountRaw: 1_523_420_000n, fromAddr: EXT, toAddr: OWNED });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [USDC], chainIds: [1] });

    const res = await computeBalances(db, { scope: { addresses: [OWNED] }, includeUnverified: true });
    expect(res.rows[0]?.amount).toBe('1523.42');
    expect(res.rows[0]?.amountRaw).toBe('1523420000');
  });

  it('surfaces backing events (refs capped at 64, totalCount exact)', async () => {
    const e = events();
    for (let i = 0; i < 65; i++) {
      e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 1n, fromAddr: EXT, toAddr: OWNED, blockNumber: i + 1 });
    }
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE], chainIds: [1] });

    const res = await computeBalances(db, { scope: { addresses: [OWNED] } });
    const row = res.rows[0];
    expect(row?.amountRaw).toBe('65');
    expect(row?.backing.totalCount).toBe(65);
    expect(row?.backing.refs).toHaveLength(64);
    expect(row?.backing.capped).toBe(true);
  });

  it('separates internal transfers into each wallet balance', async () => {
    const e = events();
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 100n, fromAddr: EXT, toAddr: OWNED });
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 30n, fromAddr: OWNED, toAddr: OWNED2 });
    await seedWorld({ events: e.list, owned: [OWNED, OWNED2], external: [EXT], tokens: [NATIVE], chainIds: [1] });

    const res = await computeBalances(db, { scope: { addresses: [OWNED, OWNED2] } });
    const byAddr = new Map(res.rows.map((r) => [r.address, r.amountRaw]));
    expect(byAddr.get(OWNED)).toBe('70');
    expect(byAddr.get(OWNED2)).toBe('30');
  });
});

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

function fullPeriod(world: World): Period {
  if (world.events.length === 0) return { from: '2026-01-01', to: '2026-01-01' };
  const times = world.events.map((e) => e.blockTime.getTime());
  return { from: isoDate(new Date(Math.min(...times))), to: isoDate(new Date(Math.max(...times))) };
}

// `periodRange` is half-open [from, toExclusive) (H10 minors); the in-memory
// fold's `TimeWindow.to` is a CLOSED bound (`inWindow`: t <= w.to), so convert by
// stepping back 1ms. Exactly equivalent to the pre-fix 'T23:59:59.999Z' literal
// at millisecond precision (JS Date cannot represent finer), which is all the
// fold ever compares against — deriving from `periodRange` keeps one source of
// truth for the day-boundary math instead of duplicating it here.
const windowOf = (p: Period): TimeWindow => {
  const { from, to } = periodRange(p);
  return { from, to: new Date(to.getTime() - 1) };
};

describe('computeFlows / computeGas — SQL ≡ fold', () => {
  const worlds = fc.sample(arbWorld, { numRuns: 6, seed: 424242 });
  worlds.forEach((world, i) => {
    it(`world #${i}: external + internal flows per token match foldFlows`, async () => {
      await seedWorld(world);
      const period = fullPeriod(world);
      const res = await computeFlows(db, { scope: { addresses: world.owned }, period, includeUnverified: true });
      const fold = foldFlows(world.events, world.owned, windowOf(period));

      const gotExt = new Map(res.rows.map((r) => [r.tokenId, { inflow: r.inflowRaw, outflow: r.outflowRaw, tx: r.txCount }]));
      const expExt = new Map<number, { inflow: string; outflow: string; tx: number }>();
      for (const [tid, a] of fold.externalByToken) {
        if (a.inflow !== 0n || a.outflow !== 0n) {
          expExt.set(tid, { inflow: a.inflow.toString(), outflow: a.outflow.toString(), tx: a.txHashes.size });
        }
      }
      expect(gotExt).toEqual(expExt);

      const gotInt = new Map(res.internal.map((r) => [r.tokenId, { amount: r.inflowRaw, tx: r.txCount }]));
      const expInt = new Map<number, { amount: string; tx: number }>();
      for (const [tid, a] of fold.internalByToken) expInt.set(tid, { amount: a.inflow.toString(), tx: a.txHashes.size });
      expect(gotInt).toEqual(expInt);
    });

    it(`world #${i}: gas per token matches foldGas`, async () => {
      await seedWorld(world);
      const period = fullPeriod(world);
      const res = await computeGas(db, { scope: { addresses: world.owned }, period });
      const fold = foldGas(world.events, world.owned, windowOf(period));

      const got = new Map(res.map((r) => [r.tokenId, { amount: r.nativeAmountRaw, tx: r.txCount }]));
      const exp = new Map<number, { amount: string; tx: number }>();
      for (const [tid, a] of fold) exp.set(tid, { amount: a.amount.toString(), tx: a.txCount });
      expect(got).toEqual(exp);
    });
  });
});

describe('computeFlows / computeGas — semantics', () => {
  const PERIOD: Period = { from: '2026-01-01', to: '2026-12-31' };

  async function seedFlowScenario(): Promise<void> {
    const e = events();
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 100n, fromAddr: EXT, toAddr: OWNED }); // external in
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 40n, fromAddr: OWNED, toAddr: EXT }); // external out
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 25n, fromAddr: OWNED, toAddr: OWNED2 }); // internal
    e.push({ eventKind: 'gas_fee', tokenId: NATIVE.tokenId, amountRaw: 5n, fromAddr: OWNED, toAddr: '0x0000000000000000000000000000000000000000' });
    await seedWorld({ events: e.list, owned: [OWNED, OWNED2], external: [EXT], tokens: [NATIVE], chainIds: [1] });
  }

  it('splits external in/out/net and separates internal, excluding gas', async () => {
    await seedFlowScenario();
    const res = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: PERIOD });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ inflowRaw: '100', outflowRaw: '40', netRaw: '60', txCount: 2 });
    expect(res.internal).toHaveLength(1);
    expect(res.internal[0]).toMatchObject({ inflowRaw: '25', txCount: 1 });
  });

  it('honours direction=in and direction=out', async () => {
    await seedFlowScenario();
    const inbound = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: PERIOD, direction: 'in' });
    expect(inbound.rows[0]).toMatchObject({ inflowRaw: '100', outflowRaw: '0' });
    const outbound = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: PERIOD, direction: 'out' });
    expect(outbound.rows[0]).toMatchObject({ inflowRaw: '0', outflowRaw: '40' });
    // `internal` is direction-agnostic by design: a self-transfer is neither an
    // inbound nor an outbound external flow, so it is reported in full for both.
    expect(inbound.internal[0]).toMatchObject({ inflowRaw: '25', txCount: 1 });
    expect(outbound.internal[0]).toMatchObject({ inflowRaw: '25', txCount: 1 });
  });

  it('sums gas_fee events only', async () => {
    await seedFlowScenario();
    const res = await computeGas(db, { scope: { addresses: [OWNED, OWNED2] }, period: PERIOD });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ tokenId: NATIVE.tokenId, nativeAmountRaw: '5', txCount: 1 });
  });
});

describe('computeFlows — group_by', () => {
  const EXT2 = '0x0000000000000000000000000000000000000e02';
  const YEAR: Period = { from: '2026-01-01', to: '2026-12-31' };
  const JAN = new Date('2026-01-15T00:00:00Z');
  const JUN = new Date('2026-06-15T00:00:00Z');

  // A single token (ETH) across two months and two external counterparties:
  //   Jan  EXT  → OWNED  100  (in,  cp EXT,  2026-01)
  //   Jan  EXT2 → OWNED   40  (in,  cp EXT2, 2026-01)
  //   Jun  OWNED→ EXT     30  (out, cp EXT,  2026-06)
  // plus one internal Jan self-transfer OWNED→OWNED2 25 (never external flow).
  async function seedGrouped(): Promise<void> {
    const e = events();
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 100n, fromAddr: EXT, toAddr: OWNED, blockTime: JAN });
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 40n, fromAddr: EXT2, toAddr: OWNED, blockTime: JAN });
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 30n, fromAddr: OWNED, toAddr: EXT, blockTime: JUN });
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 25n, fromAddr: OWNED, toAddr: OWNED2, blockTime: JAN });
    await seedWorld({ events: e.list, owned: [OWNED, OWNED2], external: [EXT, EXT2], tokens: [NATIVE], chainIds: [1] });
  }

  it('defaults to one row per token when group_by is omitted', async () => {
    await seedGrouped();
    const res = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: YEAR });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ group: { token: 'ETH' }, inflowRaw: '140', outflowRaw: '30', netRaw: '110' });
    expect(res.rows[0]?.backing.totalCount).toBe(3);
  });

  it('subdivides by month (token stays an implicit dimension)', async () => {
    await seedGrouped();
    const res = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: YEAR, groupBy: ['month'] });
    const byMonth = new Map(res.rows.map((r) => [r.group.month, r]));
    expect([...byMonth.keys()].sort()).toEqual(['2026-01', '2026-06']);
    expect(byMonth.get('2026-01')).toMatchObject({ group: { token: 'ETH', month: '2026-01' }, inflowRaw: '140', outflowRaw: '0' });
    expect(byMonth.get('2026-06')).toMatchObject({ group: { token: 'ETH', month: '2026-06' }, inflowRaw: '0', outflowRaw: '30' });
    expect(byMonth.get('2026-01')?.backing.totalCount).toBe(2);
    expect(byMonth.get('2026-06')?.backing.totalCount).toBe(1);
  });

  it('subdivides by counterparty (the not-in-scope endpoint)', async () => {
    await seedGrouped();
    const res = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: YEAR, groupBy: ['counterparty'] });
    const byCp = new Map(res.rows.map((r) => [r.group.counterparty, r]));
    expect([...byCp.keys()].sort()).toEqual([EXT, EXT2].sort());
    expect(byCp.get(EXT)).toMatchObject({ inflowRaw: '100', outflowRaw: '30', netRaw: '70' });
    expect(byCp.get(EXT2)).toMatchObject({ inflowRaw: '40', outflowRaw: '0' });
  });

  it('subdivides by (counterparty, month) composite and buckets backing per group', async () => {
    await seedGrouped();
    const res = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: YEAR, groupBy: ['counterparty', 'month'] });
    const key = (r: { group: Record<string, string> }): string => `${r.group.counterparty}|${r.group.month}`;
    const byKey = new Map(res.rows.map((r) => [key(r), r]));
    expect(byKey.get(`${EXT}|2026-01`)).toMatchObject({ inflowRaw: '100', outflowRaw: '0' });
    expect(byKey.get(`${EXT}|2026-06`)).toMatchObject({ inflowRaw: '0', outflowRaw: '30' });
    expect(byKey.get(`${EXT2}|2026-01`)).toMatchObject({ inflowRaw: '40', outflowRaw: '0' });
    for (const r of res.rows) expect(r.backing.totalCount).toBe(r.txCount);
  });

  it('applies grouping to internal self-transfers too', async () => {
    await seedGrouped();
    const res = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: YEAR, groupBy: ['month'] });
    expect(res.internal).toHaveLength(1);
    expect(res.internal[0]).toMatchObject({ group: { token: 'ETH', month: '2026-01' }, inflowRaw: '25' });
  });

  it('subdivides by day', async () => {
    await seedGrouped(); // both Jan external events on 2026-01-15, the Jun one on 2026-06-15
    const res = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: YEAR, groupBy: ['day'] });
    const byDay = new Map(res.rows.map((r) => [r.group.day, r]));
    expect([...byDay.keys()].sort()).toEqual(['2026-01-15', '2026-06-15']);
    expect(byDay.get('2026-01-15')).toMatchObject({ group: { token: 'ETH', day: '2026-01-15' }, inflowRaw: '140', outflowRaw: '0' });
    expect(byDay.get('2026-06-15')).toMatchObject({ group: { token: 'ETH', day: '2026-06-15' }, inflowRaw: '0', outflowRaw: '30' });
  });

  it('aligns backing to every group across the full 4-dim subset', async () => {
    await seedGrouped();
    const res = await computeFlows(db, { scope: { addresses: [OWNED, OWNED2] }, period: YEAR, groupBy: ['token', 'counterparty', 'day', 'month'] });
    // Each external event is its own (token, cp, day, month) bucket → totalCount == txCount == 1.
    expect(res.rows).toHaveLength(3);
    for (const r of res.rows) expect(r.backing.totalCount).toBe(r.txCount);
    const byKey = new Map(res.rows.map((r) => [`${r.group.counterparty}|${r.group.day}`, r]));
    expect(byKey.get(`${EXT}|2026-01-15`)).toMatchObject({ inflowRaw: '100', outflowRaw: '0' });
    expect(byKey.get(`${EXT2}|2026-01-15`)).toMatchObject({ inflowRaw: '40', outflowRaw: '0' });
    expect(byKey.get(`${EXT}|2026-06-15`)).toMatchObject({ inflowRaw: '0', outflowRaw: '30' });
  });
});

describe('computeGas — group_by', () => {
  const YEAR: Period = { from: '2026-01-01', to: '2026-12-31' };
  const JAN = new Date('2026-01-15T00:00:00Z');
  const JUN = new Date('2026-06-15T00:00:00Z');
  const SINK = '0x0000000000000000000000000000000000000000';

  // Gas payers are the `from` side: OWNED pays 5 (Jan) + 3 (Jun); OWNED2 pays 2 (Jan).
  async function seedGasGrouped(): Promise<void> {
    const e = events();
    e.push({ eventKind: 'gas_fee', tokenId: NATIVE.tokenId, amountRaw: 5n, fromAddr: OWNED, toAddr: SINK, blockTime: JAN });
    e.push({ eventKind: 'gas_fee', tokenId: NATIVE.tokenId, amountRaw: 3n, fromAddr: OWNED, toAddr: SINK, blockTime: JUN });
    e.push({ eventKind: 'gas_fee', tokenId: NATIVE.tokenId, amountRaw: 2n, fromAddr: OWNED2, toAddr: SINK, blockTime: JAN });
    await seedWorld({ events: e.list, owned: [OWNED, OWNED2], external: [EXT], tokens: [NATIVE], chainIds: [1] });
  }
  const scope = { addresses: [OWNED, OWNED2] };

  it('defaults to one per-chain row with chain always in the group', async () => {
    await seedGasGrouped();
    const res = await computeGas(db, { scope, period: YEAR });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ group: { chain: '1' }, nativeAmountRaw: '10', txCount: 3 });
    expect(res[0]?.backing.totalCount).toBe(3);
  });

  it('subdivides by month (chain stays an implicit dimension)', async () => {
    await seedGasGrouped();
    const res = await computeGas(db, { scope, period: YEAR, groupBy: ['month'] });
    const byMonth = new Map(res.map((r) => [r.group.month, r]));
    expect([...byMonth.keys()].sort()).toEqual(['2026-01', '2026-06']);
    expect(byMonth.get('2026-01')).toMatchObject({ group: { chain: '1', month: '2026-01' }, nativeAmountRaw: '7', txCount: 2 });
    expect(byMonth.get('2026-06')).toMatchObject({ group: { chain: '1', month: '2026-06' }, nativeAmountRaw: '3', txCount: 1 });
    for (const r of res) expect(r.backing.totalCount).toBe(r.txCount);
  });

  it('subdivides by wallet (the payer)', async () => {
    await seedGasGrouped();
    const res = await computeGas(db, { scope, period: YEAR, groupBy: ['wallet'] });
    const byWallet = new Map(res.map((r) => [r.group.wallet, r]));
    expect(byWallet.get(OWNED)).toMatchObject({ nativeAmountRaw: '8', txCount: 2 });
    expect(byWallet.get(OWNED2)).toMatchObject({ nativeAmountRaw: '2', txCount: 1 });
  });

  it('subdivides by (wallet, month) composite and buckets backing per group', async () => {
    await seedGasGrouped();
    const res = await computeGas(db, { scope, period: YEAR, groupBy: ['wallet', 'month'] });
    const key = (r: { group: Record<string, string> }): string => `${r.group.wallet}|${r.group.month}`;
    const byKey = new Map(res.map((r) => [key(r), r]));
    expect(byKey.get(`${OWNED}|2026-01`)).toMatchObject({ nativeAmountRaw: '5', txCount: 1 });
    expect(byKey.get(`${OWNED}|2026-06`)).toMatchObject({ nativeAmountRaw: '3', txCount: 1 });
    expect(byKey.get(`${OWNED2}|2026-01`)).toMatchObject({ nativeAmountRaw: '2', txCount: 1 });
    for (const r of res) expect(r.backing.totalCount).toBe(r.txCount);
  });
});

describe('listEvents — pagination and filters', () => {
  it('is page-boundary independent: limits {10,100,1000} yield the identical ordered set', async () => {
    const e = events();
    for (let i = 0; i < 250; i++) {
      e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 1n, fromAddr: EXT, toAddr: OWNED });
    }
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE], chainIds: [1] });

    const pageAll = async (limit: number): Promise<number[]> => {
      const ids: number[] = [];
      let cursor: string | undefined;
      for (;;) {
        const res = await listEvents(db, { scope: { addresses: [OWNED] }, limit, ...(cursor ? { cursor } : {}) });
        ids.push(...res.events.map((x) => x.id));
        if (res.nextCursor === undefined) break;
        cursor = res.nextCursor;
      }
      return ids;
    };
    const [a, b, c] = [await pageAll(10), await pageAll(100), await pageAll(1000)];
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toHaveLength(250);

    const first = await listEvents(db, { scope: { addresses: [OWNED] }, limit: 10 });
    expect(first.totalCount).toBe(250);
    expect(first.events).toHaveLength(10);
    expect(first.nextCursor).toBeDefined();
  });

  async function seedMixed(): Promise<void> {
    const e = events();
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 100n, fromAddr: EXT, toAddr: OWNED }); // in
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 40n, fromAddr: OWNED, toAddr: EXT }); // out
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 25n, fromAddr: OWNED, toAddr: OWNED2 }); // internal
    e.push({ eventKind: 'gas_fee', tokenId: NATIVE.tokenId, amountRaw: 5n, fromAddr: OWNED, toAddr: '0x0000000000000000000000000000000000000000' });
    e.push({ eventKind: 'erc20_transfer', tokenId: USDC.tokenId, amountRaw: 1_000_000n, fromAddr: EXT, toAddr: OWNED }); // in, verified
    e.push({ eventKind: 'erc20_transfer', tokenId: SPAM.tokenId, amountRaw: 999n, fromAddr: EXT, toAddr: OWNED }); // in, unverified
    await seedWorld(
      { events: e.list, owned: [OWNED, OWNED2], external: [EXT], tokens: [NATIVE, USDC, SPAM], chainIds: [1] },
      new Set([NATIVE.tokenId, USDC.tokenId]),
    );
  }
  const scope = { addresses: [OWNED, OWNED2] };

  it('excludes unverified tokens by default; includes them on request', async () => {
    await seedMixed();
    const def = await listEvents(db, { scope });
    expect(def.events.some((x) => x.token.tokenId === SPAM.tokenId)).toBe(false);
    expect(def.totalCount).toBe(5);
    const all = await listEvents(db, { scope, includeUnverified: true });
    expect(all.totalCount).toBe(6);
  });

  it('filters by kind, token, and counterparty', async () => {
    await seedMixed();
    const gas = await listEvents(db, { scope, kinds: ['gas_fee'] });
    expect(gas.events.map((x) => x.amountRaw)).toEqual(['5']);

    const usdc = await listEvents(db, { scope, tokens: [{ chainId: 1, address: USDC.address }] });
    expect(usdc.events.map((x) => x.token.tokenId)).toEqual([USDC.tokenId]);

    const cp = await listEvents(db, { scope, counterpartyAddress: EXT });
    expect(new Set(cp.events.map((x) => x.amountRaw))).toEqual(new Set(['100', '40', '1000000']));
  });

  it('labels each row in/out/internal relative to the scope', async () => {
    await seedMixed();
    const res = await listEvents(db, { scope, kinds: ['native_transfer'] });
    const dir = new Map(res.events.map((x) => [x.amountRaw, x.direction]));
    expect(dir.get('100')).toBe('in');
    expect(dir.get('40')).toBe('out');
    expect(dir.get('25')).toBe('internal');
  });

  it('applies min_amount as a per-token display threshold', async () => {
    const e = events();
    for (const amt of [5n, 50n, 500n]) {
      e.push({ eventKind: 'erc20_transfer', tokenId: TOK0.tokenId, amountRaw: amt, fromAddr: EXT, toAddr: OWNED });
    }
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [TOK0], chainIds: [1] });
    const res = await listEvents(db, { scope: { addresses: [OWNED] }, minAmount: '50' });
    expect(res.events.map((x) => x.amountRaw).sort()).toEqual(['50', '500']);
  });

  it('scales min_amount to base units exactly at 18 decimals', async () => {
    // decimals=18 puts the 10^d factor past a float's exact-integer range — the
    // real-world case TOK0 (decimals=0) never exercises. Threshold '1' == 10^18
    // base units: keep amounts >= 1.0, drop 0.5.
    const TOK18: TokenSpec = { tokenId: 5, chainId: 1, address: '0x00000000000000000000000000000000000000c5', decimals: 18, standard: 'erc20' };
    const e = events();
    for (const amt of [500000000000000000n, 1000000000000000000n, 2000000000000000000n]) {
      e.push({ eventKind: 'erc20_transfer', tokenId: TOK18.tokenId, amountRaw: amt, fromAddr: EXT, toAddr: OWNED });
    }
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [TOK18], chainIds: [1] });
    const res = await listEvents(db, { scope: { addresses: [OWNED] }, minAmount: '1' });
    expect(res.events.map((x) => x.amountRaw).sort()).toEqual(['1000000000000000000', '2000000000000000000']);
  });

  it('rejects a malformed min_amount with a clean domain error, not a raw pg cast error', async () => {
    const e = events();
    e.push({ eventKind: 'erc20_transfer', tokenId: TOK0.tokenId, amountRaw: 5n, fromAddr: EXT, toAddr: OWNED });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [TOK0], chainIds: [1] });
    const scope = { addresses: [OWNED] };
    await expect(listEvents(db, { scope, minAmount: 'abc' })).rejects.toThrow(RangeError);
    await expect(listEvents(db, { scope, minAmount: 'not a number' })).rejects.toThrow(/min_amount/);
    // A well-formed threshold still works (the guard is shape-only).
    const ok = await listEvents(db, { scope, minAmount: '1' });
    expect(ok.events.map((x) => x.amountRaw)).toEqual(['5']);
  });

  it('returns total_count on the first page only, omitted on cursor pages', async () => {
    const e = events();
    for (let i = 0; i < 5; i++) {
      e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 1n, fromAddr: EXT, toAddr: OWNED });
    }
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE], chainIds: [1] });
    const scope = { addresses: [OWNED] };

    const first = await listEvents(db, { scope, limit: 2 });
    expect(first.totalCount).toBe(5);
    expect(first.nextCursor).toBeDefined();

    // Cursor pages skip the full COUNT(*) re-scan; the client caches total_count.
    const second = await listEvents(db, { scope, limit: 2, cursor: first.nextCursor! });
    expect(second.totalCount).toBeUndefined();
    expect(second.events).toHaveLength(2);
  });

  it('omits total_count on an empty-scope cursor page but includes it on the first page', async () => {
    // The empty-scope path short-circuits before the DB round trip, but must still
    // honour "first page only" (cursor absent) — a cursor page never carries totalCount,
    // regardless of which branch produced the empty result (types.ts: "first page only").
    const first = await listEvents(db, { scope: { addresses: [] } });
    expect(first.totalCount).toBe(0);
    expect(first.events).toEqual([]);

    const cursored = await listEvents(db, { scope: { addresses: [] }, cursor: 'anything' });
    expect(cursored.totalCount).toBeUndefined();
    expect(cursored.events).toEqual([]);
  });
});

describe('periodRange — half-open day boundary (H10 minors)', () => {
  it('includes a microsecond-precision event just before midnight, excludes one exactly at next midnight', async () => {
    // block_time is TIMESTAMPTZ (microsecond precision); the driver/Date path can't
    // express sub-millisecond values, so insert via raw SQL to exercise the true
    // boundary. Under the OLD closed '23:59:59.999Z' upper bound, the first event
    // (…999500) would have been wrongly excluded (999500 > 999000 the old lte
    // literal); under the new half-open [from, nextMidnight) range it lands inside.
    await pool.query('TRUNCATE chain_events, tokens RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO tokens (id, chain_id, address, standard, decimals, is_stablecoin, peg_currency, verified, symbol_display)
       OVERRIDING SYSTEM VALUE VALUES (1,1,NULL,'native',18,false,NULL,true,'ETH')`,
    );
    await pool.query(
      `INSERT INTO chain_events
         (chain_id, tx_hash, log_index, event_kind, token_id, amount_raw, from_addr, to_addr,
          block_number, block_time, tx_from, tx_to, provider, raw)
       VALUES
         (1, '0x01', -1, 'native_transfer', 1, 1, $1, $2, 1, '2026-01-01T23:59:59.999500Z', $1, $2, 'fixture', '{}'),
         (1, '0x02', -1, 'native_transfer', 1, 1, $1, $2, 2, '2026-01-02T00:00:00.000000Z', $1, $2, 'fixture', '{}')`,
      [EXT, OWNED],
    );

    const period: Period = { from: '2026-01-01', to: '2026-01-01' };
    const res = await listEvents(db, { scope: { addresses: [OWNED] }, period });
    expect(res.events.map((e) => e.blockNumber)).toEqual([1]);
  });
});

describe('computeCounterparties — SQL ≡ fold', () => {
  const worlds = fc.sample(arbWorld, { numRuns: 6, seed: 909090 });
  worlds.forEach((world, i) => {
    it(`world #${i}: per-counterparty per-token turnover + txCount match foldCounterparties`, async () => {
      await seedWorld(world);
      const period = fullPeriod(world);
      const res = await computeCounterparties(db, { scope: { addresses: world.owned }, period, includeUnverified: true, topN: 100_000 });
      const fold = foldCounterparties(world.events, world.owned, windowOf(period));

      const norm = (
        tokens: Map<number, { inflow: string; outflow: string }>,
        txCount: number,
      ): { tokens: Map<number, { inflow: string; outflow: string }>; txCount: number } => ({ tokens, txCount });

      const exp = new Map<string, ReturnType<typeof norm>>();
      for (const [cp, byToken] of fold) {
        const tokens = new Map<number, { inflow: string; outflow: string }>();
        const txs = new Set<string>();
        for (const [tid, a] of byToken) {
          tokens.set(tid, { inflow: a.inflow.toString(), outflow: a.outflow.toString() });
          for (const h of a.txHashes) txs.add(h);
        }
        exp.set(cp, norm(tokens, txs.size));
      }

      const got = new Map<string, ReturnType<typeof norm>>();
      for (const row of res.rows) {
        const tokens = new Map(row.perToken.map((t) => [t.token.tokenId, { inflow: t.inflowRaw, outflow: t.outflowRaw }]));
        got.set(row.address, norm(tokens, row.txCount));
      }
      expect(got).toEqual(exp);
      expect(res.totalCounterparties).toBe(exp.size);
    });
  });
});

describe('computeStablecoinMovements', () => {
  const USDC_S: TokenSpec = { tokenId: 2, chainId: 1, address: USDC.address, decimals: 6, standard: 'erc20', isStablecoin: true, pegCurrency: 'USD' };
  const EURC_S: TokenSpec = { tokenId: 5, chainId: 1, address: '0x00000000000000000000000000000000000000c5', decimals: 6, standard: 'erc20', isStablecoin: true, pegCurrency: 'EUR' };
  const period: Period = { from: '2026-01-01', to: '2026-12-31' };

  async function seedStable(): Promise<void> {
    const e = events();
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 100n, fromAddr: EXT, toAddr: OWNED });
    e.push({ eventKind: 'erc20_transfer', tokenId: USDC_S.tokenId, amountRaw: 1_000_000n, fromAddr: EXT, toAddr: OWNED });
    e.push({ eventKind: 'erc20_transfer', tokenId: EURC_S.tokenId, amountRaw: 2_000_000n, fromAddr: EXT, toAddr: OWNED });
    e.push({ eventKind: 'erc20_transfer', tokenId: SPAM.tokenId, amountRaw: 999n, fromAddr: EXT, toAddr: OWNED });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE, USDC_S, EURC_S, SPAM], chainIds: [1] });
  }

  it('restricts flows to verified stablecoins (excludes native and non-stablecoin erc20)', async () => {
    await seedStable();
    const res = await computeStablecoinMovements(db, { scope: { addresses: [OWNED] }, period });
    expect(new Set(res.rows.map((r) => r.tokenId))).toEqual(new Set([USDC_S.tokenId, EURC_S.tokenId]));
  });

  it('narrows to a single peg currency', async () => {
    await seedStable();
    const usd = await computeStablecoinMovements(db, { scope: { addresses: [OWNED] }, period, pegCurrency: 'USD' });
    expect(usd.rows.map((r) => r.tokenId)).toEqual([USDC_S.tokenId]);
  });

  it('forwards group_by to the flow fold (subdivides by month)', async () => {
    const e = events();
    e.push({ eventKind: 'erc20_transfer', tokenId: USDC_S.tokenId, amountRaw: 1_000_000n, fromAddr: EXT, toAddr: OWNED, blockTime: new Date('2026-01-15T00:00:00Z') });
    e.push({ eventKind: 'erc20_transfer', tokenId: USDC_S.tokenId, amountRaw: 3_000_000n, fromAddr: EXT, toAddr: OWNED, blockTime: new Date('2026-06-15T00:00:00Z') });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE, USDC_S], chainIds: [1] });

    const res = await computeStablecoinMovements(db, { scope: { addresses: [OWNED] }, period, groupBy: ['month'] });
    const byMonth = new Map(res.rows.map((r) => [r.group.month, r]));
    expect([...byMonth.keys()].sort()).toEqual(['2026-01', '2026-06']);
    expect(byMonth.get('2026-01')).toMatchObject({ group: { month: '2026-01' }, inflowRaw: '1000000' });
    expect(byMonth.get('2026-06')).toMatchObject({ group: { month: '2026-06' }, inflowRaw: '3000000' });
  });
});

describe('computeCounterparties — ranking', () => {
  const EXT_A = '0x0000000000000000000000000000000000000eaa';
  const EXT_B = '0x0000000000000000000000000000000000000ebb';

  it('ranks by txCount desc and truncates to top_n', async () => {
    const e = events();
    for (let i = 0; i < 3; i++) e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 10n, fromAddr: EXT_A, toAddr: OWNED });
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 5n, fromAddr: EXT_B, toAddr: OWNED });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT_A, EXT_B], tokens: [NATIVE], chainIds: [1] });

    const period: Period = { from: '2026-01-01', to: '2026-12-31' };
    const full = await computeCounterparties(db, { scope: { addresses: [OWNED] }, period });
    expect(full.rows.map((r) => r.address)).toEqual([EXT_A, EXT_B]);
    expect(full.rows[0]?.txCount).toBe(3);

    const top1 = await computeCounterparties(db, { scope: { addresses: [OWNED] }, period, topN: 1 });
    expect(top1.rows.map((r) => r.address)).toEqual([EXT_A]);
    expect(top1.totalCounterparties).toBe(2);
    expect(top1.truncatedCount).toBe(1);
  });
});

describe('dropped-token consistency (H10 minors)', () => {
  // `chain_events.token_id` is FK-constrained to `tokens.id` (ADR-005), so a row
  // whose token is genuinely absent from `tokens` cannot be seeded — the reachable
  // analog is a token the default (verified-only) filter drops. Before this fix,
  // counterparties.ts derived txCount/backing from an independently-issued query
  // sharing only the same WHERE text as the turnover query; this proves they stay
  // tied to one row set: a counterparty whose only token is unverified must not
  // surface as a ghost row (txCount > 0, backing refs, empty perToken).
  const period: Period = { from: '2026-01-01', to: '2026-12-31' };

  it('computeCounterparties: a counterparty whose only token is dropped does not appear at all', async () => {
    const e = events();
    e.push({ eventKind: 'erc20_transfer', tokenId: SPAM.tokenId, amountRaw: 10n, fromAddr: EXT, toAddr: OWNED });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [SPAM], chainIds: [1] }, new Set()); // SPAM unverified

    const res = await computeCounterparties(db, { scope: { addresses: [OWNED] }, period });
    expect(res.rows.find((r) => r.address === EXT)).toBeUndefined();
    expect(res.totalCounterparties).toBe(0);

    // With includeUnverified the same events resolve the token and the counterparty
    // appears fully (perToken non-empty, txCount matches) — same code path, no drop.
    const all = await computeCounterparties(db, { scope: { addresses: [OWNED] }, period, includeUnverified: true });
    expect(all.rows.map((r) => r.address)).toEqual([EXT]);
    expect(all.rows[0]?.perToken).toHaveLength(1);
    expect(all.rows[0]?.txCount).toBe(1);
  });

  it('computeFlows: a dropped (unverified) token never contributes a row or orphaned backing to a surviving row', async () => {
    const e = events();
    e.push({ eventKind: 'erc20_transfer', tokenId: USDC.tokenId, amountRaw: 1_000_000n, fromAddr: EXT, toAddr: OWNED });
    e.push({ eventKind: 'erc20_transfer', tokenId: SPAM.tokenId, amountRaw: 999n, fromAddr: EXT, toAddr: OWNED });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [USDC, SPAM], chainIds: [1] }, new Set([USDC.tokenId]));

    const res = await computeFlows(db, { scope: { addresses: [OWNED] }, period });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ tokenId: USDC.tokenId, inflowRaw: '1000000' });
    expect(res.rows[0]?.backing.totalCount).toBe(1); // only the surviving token's own event, not the dropped SPAM one
  });
});

describe('scope.chainIds — single home (H10)', () => {
  // Two chains, distinct native tokens, distinct external counterparties per chain —
  // `scope.chainIds` (not a top-level param) must be the only spelling that filters
  // flows/gas/counterparties/listEvents (types.ts no longer carries a duplicate).
  const NATIVE_C1: TokenSpec = { tokenId: 10, chainId: 1, address: null, decimals: 18, standard: 'native' };
  const NATIVE_C2: TokenSpec = { tokenId: 11, chainId: 8453, address: null, decimals: 18, standard: 'native' };
  const EXT_C1 = '0x0000000000000000000000000000000000000c01';
  const EXT_C2 = '0x0000000000000000000000000000000000000c02';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const period: Period = { from: '2026-01-01', to: '2026-12-31' };

  async function seedTwoChains(): Promise<void> {
    const e = events();
    e.push({ eventKind: 'native_transfer', chainId: 1, tokenId: NATIVE_C1.tokenId, amountRaw: 100n, fromAddr: EXT_C1, toAddr: OWNED });
    e.push({ eventKind: 'gas_fee', chainId: 1, tokenId: NATIVE_C1.tokenId, amountRaw: 3n, fromAddr: OWNED, toAddr: ZERO });
    e.push({ eventKind: 'native_transfer', chainId: 8453, tokenId: NATIVE_C2.tokenId, amountRaw: 50n, fromAddr: EXT_C2, toAddr: OWNED });
    e.push({ eventKind: 'gas_fee', chainId: 8453, tokenId: NATIVE_C2.tokenId, amountRaw: 2n, fromAddr: OWNED, toAddr: ZERO });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT_C1, EXT_C2], tokens: [NATIVE_C1, NATIVE_C2], chainIds: [1, 8453] });
  }

  it('computeFlows filters via scope.chainIds (positive + negative)', async () => {
    await seedTwoChains();
    const c1 = await computeFlows(db, { scope: { addresses: [OWNED], chainIds: [1] }, period });
    expect(c1.rows).toHaveLength(1);
    expect(c1.rows[0]).toMatchObject({ inflowRaw: '100' });

    const c2 = await computeFlows(db, { scope: { addresses: [OWNED], chainIds: [8453] }, period });
    expect(c2.rows).toHaveLength(1);
    expect(c2.rows[0]).toMatchObject({ inflowRaw: '50' });

    const both = await computeFlows(db, { scope: { addresses: [OWNED] }, period });
    expect(both.rows).toHaveLength(2);
  });

  it('computeGas filters via scope.chainIds (positive + negative)', async () => {
    await seedTwoChains();
    const c1 = await computeGas(db, { scope: { addresses: [OWNED], chainIds: [1] }, period });
    expect(c1).toHaveLength(1);
    expect(c1[0]).toMatchObject({ chainId: 1, nativeAmountRaw: '3' });

    const c2 = await computeGas(db, { scope: { addresses: [OWNED], chainIds: [8453] }, period });
    expect(c2).toHaveLength(1);
    expect(c2[0]).toMatchObject({ chainId: 8453, nativeAmountRaw: '2' });
  });

  it('computeCounterparties filters via scope.chainIds (positive + negative)', async () => {
    await seedTwoChains();
    const c1 = await computeCounterparties(db, { scope: { addresses: [OWNED], chainIds: [1] }, period });
    expect(c1.rows.map((r) => r.address)).toEqual([EXT_C1]);

    const c2 = await computeCounterparties(db, { scope: { addresses: [OWNED], chainIds: [8453] }, period });
    expect(c2.rows.map((r) => r.address)).toEqual([EXT_C2]);

    const both = await computeCounterparties(db, { scope: { addresses: [OWNED] }, period });
    expect(both.rows.map((r) => r.address).sort()).toEqual([EXT_C1, EXT_C2].sort());
  });

  it('listEvents filters via scope.chainIds (positive + negative)', async () => {
    await seedTwoChains();
    const c1 = await listEvents(db, { scope: { addresses: [OWNED], chainIds: [1] } });
    expect(c1.events.every((x) => x.chainId === 1)).toBe(true);
    expect(c1.events.length).toBeGreaterThan(0);

    const c2 = await listEvents(db, { scope: { addresses: [OWNED], chainIds: [8453] } });
    expect(c2.events.every((x) => x.chainId === 8453)).toBe(true);
    expect(c2.events.length).toBeGreaterThan(0);

    const neither = await listEvents(db, { scope: { addresses: [OWNED], chainIds: [999999] } });
    expect(neither.events).toEqual([]);
  });
});

describe('getLedgerStatus', () => {
  it('reports coverage, freshness, anchoring, and errors per (address, chain)', async () => {
    const e = events();
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 1n, fromAddr: EXT, toAddr: OWNED, blockNumber: 90, blockTime: new Date('2026-03-01T00:00:00Z') });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE], chainIds: [1] });
    await pool.query('TRUNCATE ingestion_checkpoints');

    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block, anchor_block, last_error, updated_at) VALUES
        (1, $1, 'native', 'live', 100, NULL, NULL, $2),
        (1, $1, 'erc20', 'backfilling', 50, 10, NULL, $3),
        (8453, $1, 'native', 'error', 0, NULL, 'boom', $2)`,
      [OWNED, fresh, stale],
    );

    const cov = await getLedgerStatus(db, { addresses: [OWNED] });
    const byChain = new Map(cov.map((c) => [c.chainId, c]));

    const c1 = byChain.get(1)!;
    expect(c1.anchored).toBe(true);
    const native = c1.streams.find((s) => s.stream === 'native')!;
    const erc20 = c1.streams.find((s) => s.stream === 'erc20')!;
    expect(native).toMatchObject({ status: 'live', lastProcessedBlock: 100, stale: false });
    expect(native.lastBlockTime).toBe('2026-03-01T00:00:00.000Z');
    expect(erc20).toMatchObject({ status: 'backfilling', anchorBlock: 10, stale: true });

    const c2 = byChain.get(8453)!;
    expect(c2.anchored).toBe(false);
    expect(c2.streams[0]).toMatchObject({ status: 'error', lastError: 'boom' });
    expect(c2.streams[0]?.lastBlockTime).toBeUndefined();
  });

  it('resolves lastBlockTime from from- and to-side activity across chains', async () => {
    // The as-of anchor is the max block_time over events where the wallet is the
    // sender OR the recipient. Isolate each side on its own chain so a per-side
    // (from∪to) grouped scan is proven, not just the to-side the case above covers.
    const NATIVE_BASE: TokenSpec = { tokenId: 6, chainId: 8453, address: null, decimals: 18, standard: 'native' };
    const e = events();
    // chain 1: OWNED is only a SENDER (from-side)
    e.push({ eventKind: 'native_transfer', chainId: 1, tokenId: NATIVE.tokenId, amountRaw: 1n, fromAddr: OWNED, toAddr: EXT, blockNumber: 10, blockTime: new Date('2026-02-01T00:00:00Z') });
    // chain 8453: OWNED is only a RECIPIENT (to-side)
    e.push({ eventKind: 'native_transfer', chainId: 8453, tokenId: NATIVE_BASE.tokenId, amountRaw: 1n, fromAddr: EXT, toAddr: OWNED, blockNumber: 20, blockTime: new Date('2026-04-01T00:00:00Z') });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE, NATIVE_BASE], chainIds: [1, 8453] });
    await pool.query('TRUNCATE ingestion_checkpoints');
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block, updated_at) VALUES
        (1, $1, 'native', 'live', 100, $2),
        (8453, $1, 'native', 'live', 100, $2)`,
      [OWNED, now],
    );

    const cov = await getLedgerStatus(db, { addresses: [OWNED] });
    const byChain = new Map(cov.map((c) => [c.chainId, c]));
    expect(byChain.get(1)!.streams[0]?.lastBlockTime).toBe('2026-02-01T00:00:00.000Z');
    expect(byChain.get(8453)!.streams[0]?.lastBlockTime).toBe('2026-04-01T00:00:00.000Z');
  });

  it('H9 kill-shot: an old erc20 transfer and a recent native transfer give each stream its OWN lastBlockTime', async () => {
    // Before the fix, both streams inherited one wallet-wide max(block_time) — the
    // recent native transfer would have leaked onto the (actually dead) erc20
    // stream, defeating the DATA_STALE signal it feeds.
    const e = events();
    e.push({ eventKind: 'erc20_transfer', tokenId: USDC.tokenId, amountRaw: 100n, fromAddr: EXT, toAddr: OWNED, blockTime: new Date('2025-01-01T00:00:00Z'), blockNumber: 1 });
    e.push({ eventKind: 'native_transfer', tokenId: NATIVE.tokenId, amountRaw: 1n, fromAddr: EXT, toAddr: OWNED, blockTime: new Date('2026-03-01T00:00:00Z'), blockNumber: 2 });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE, USDC], chainIds: [1] });
    await pool.query('TRUNCATE ingestion_checkpoints');
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block, updated_at) VALUES
        (1, $1, 'native', 'live', 100, $2),
        (1, $1, 'erc20', 'live', 100, $2)`,
      [OWNED, now],
    );

    const cov = await getLedgerStatus(db, { addresses: [OWNED] });
    const c1 = cov.find((c) => c.chainId === 1)!;
    const native = c1.streams.find((s) => s.stream === 'native')!;
    const erc20 = c1.streams.find((s) => s.stream === 'erc20')!;
    expect(erc20.lastBlockTime).toBe('2025-01-01T00:00:00.000Z');
    expect(native.lastBlockTime).toBe('2026-03-01T00:00:00.000Z');
  });

  it('an erc20-anchored wallet (opening_balance on an erc20 token, no erc20 transfers) reflects the anchor on the erc20 stream only', async () => {
    // opening_balance is written for whichever stream anchored it (anchor.ts:
    // nativeBalances() vs erc20Balances()) — same eventKind either way, so only
    // the anchored TOKEN's standard (not the eventKind) says which stream this
    // is. This is the case a kind-only native_transfer/gas_fee/erc20_transfer/
    // opening_balance→stream map gets wrong for an erc20 anchor.
    const e = events();
    e.push({ eventKind: 'opening_balance', tokenId: USDC.tokenId, amountRaw: 5_000_000n, fromAddr: '0x0000000000000000000000000000000000000000', toAddr: OWNED, blockTime: new Date('2024-06-01T00:00:00Z'), blockNumber: 1 });
    await seedWorld({ events: e.list, owned: [OWNED], external: [EXT], tokens: [NATIVE, USDC], chainIds: [1] });
    await pool.query('TRUNCATE ingestion_checkpoints');
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block, anchor_block, updated_at) VALUES
        (1, $1, 'native', 'backfilling', 0, NULL, $2),
        (1, $1, 'erc20', 'backfilling', 1, 1, $2)`,
      [OWNED, now],
    );

    const cov = await getLedgerStatus(db, { addresses: [OWNED] });
    const c1 = cov.find((c) => c.chainId === 1)!;
    const native = c1.streams.find((s) => s.stream === 'native')!;
    const erc20 = c1.streams.find((s) => s.stream === 'erc20')!;
    expect(erc20.lastBlockTime).toBe('2024-06-01T00:00:00.000Z');
    expect(native.lastBlockTime).toBeUndefined();
  });

  it('picks the wallet integrity result deterministically when both streams report one', async () => {
    // Checkpoint row order from Postgres is otherwise unspecified; without the
    // ORDER BY (chainId, address, stream) in getLedgerStatus this pick could flip
    // between runs. 'erc20' < 'native' lexically, so ascending order visits erc20
    // first — the documented winner (status.ts).
    await pool.query('TRUNCATE chain_events, tokens RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE ingestion_checkpoints');
    const now = new Date().toISOString();
    const nativeIntegrity = JSON.stringify({ checked_at: 'native-check', drifts: [] });
    const erc20Integrity = JSON.stringify({ checked_at: 'erc20-check', drifts: [] });
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block, last_integrity, updated_at) VALUES
        (1, $1, 'native', 'live', 100, $2, $4),
        (1, $1, 'erc20', 'live', 100, $3, $4)`,
      [OWNED, nativeIntegrity, erc20Integrity, now],
    );

    const cov = await getLedgerStatus(db, { addresses: [OWNED] });
    expect(cov).toHaveLength(1);
    expect(cov[0]?.integrity).toEqual({ checked_at: 'erc20-check', drifts: [] });
  });

  it('falls back to the native stream integrity when erc20 has none', async () => {
    await pool.query('TRUNCATE chain_events, tokens RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE ingestion_checkpoints');
    const now = new Date().toISOString();
    const nativeIntegrity = JSON.stringify({ checked_at: 'native-check', drifts: [] });
    await pool.query(
      `INSERT INTO ingestion_checkpoints (chain_id, address, stream, status, last_processed_block, last_integrity, updated_at) VALUES
        (1, $1, 'native', 'live', 100, $2, $3),
        (1, $1, 'erc20', 'live', 100, NULL, $3)`,
      [OWNED, nativeIntegrity, now],
    );

    const cov = await getLedgerStatus(db, { addresses: [OWNED] });
    expect(cov[0]?.integrity).toEqual({ checked_at: 'native-check', drifts: [] });
  });
});

/**
 * Valid-by-construction event-history generator (fast-check). Balances of owned
 * wallets never go negative (a wallet cannot send what it does not have), gas is
 * only charged on outgoing txs of owned wallets, and block time/number strictly
 * increase. External counterparties are the "outside world" — unbounded, their
 * balances not modeled. See docs/architecture/04-testing.md §3.
 */
import fc from 'fast-check';

import type { EventKind, LedgerEvent } from '../src/types.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);
const ERC20_DECIMALS = [0, 6, 8, 18] as const;

export interface TokenSpec {
  tokenId: number;
  chainId: number;
  address: string | null; // null = native
  decimals: number;
  standard: 'native' | 'erc20';
  isStablecoin?: boolean;
  pegCurrency?: string | null;
}

export interface World {
  events: LedgerEvent[];
  owned: string[]; // wallets whose non-negativity is enforced; test scopes ⊆ owned
  external: string[];
  tokens: TokenSpec[];
  chainIds: number[];
}

/** Distinct, lowercase, checksum-free 20-byte address from a (tag, index) pair. */
function mkAddr(tag: number, i: number): string {
  const hex = (BigInt(tag) * 1_000_000n + BigInt(i)).toString(16);
  return `0x${hex.padStart(40, '0')}`;
}

interface OpSeed {
  kind: number; // 0 in, 1 out, 2 internal, 3 gas
  fromIdx: number;
  toIdx: number;
  tokenIdx: number;
  inAmount: bigint;
  frac: number; // 1..1000, fraction of balance to spend
}

const opSeed: fc.Arbitrary<OpSeed> = fc.record({
  kind: fc.integer({ min: 0, max: 3 }),
  fromIdx: fc.nat({ max: 63 }),
  toIdx: fc.nat({ max: 63 }),
  tokenIdx: fc.nat({ max: 63 }),
  inAmount: fc.bigInt({ min: 1n, max: 10n ** 24n }),
  frac: fc.integer({ min: 1, max: 1000 }),
});

/** Spend at most the whole balance, at least 1 unit (balance is guaranteed ≥ 1). */
function clampSpend(balance: bigint, frac: number): bigint {
  if (balance <= 0n) return 0n;
  let a = (balance * BigInt(frac)) / 1000n;
  if (a < 1n) a = 1n;
  if (a > balance) a = balance;
  return a;
}

interface WorldSeed {
  numOwned: number;
  numExternal: number;
  numChains: number;
  numErc20: number;
  ops: OpSeed[];
}

function build(seed: WorldSeed): World {
  const chainIds = seed.numChains === 1 ? [1] : [1, 8453];
  const tokens: TokenSpec[] = [];
  let tokenId = 1;
  for (const chainId of chainIds) {
    tokens.push({ tokenId: tokenId++, chainId, address: null, decimals: 18, standard: 'native' });
  }
  for (let i = 0; i < seed.numErc20; i++) {
    const chainId = chainIds[i % chainIds.length]!;
    tokens.push({
      tokenId: tokenId++,
      chainId,
      address: mkAddr(3, i),
      decimals: ERC20_DECIMALS[i % ERC20_DECIMALS.length]!,
      standard: 'erc20',
    });
  }

  const owned = Array.from({ length: seed.numOwned }, (_, i) => mkAddr(1, i));
  const external = Array.from({ length: seed.numExternal }, (_, i) => mkAddr(2, i));

  // owned address -> tokenId -> balance
  const bal = new Map<string, Map<number, bigint>>();
  const get = (a: string, t: number): bigint => bal.get(a)?.get(t) ?? 0n;
  const set = (a: string, t: number, v: bigint): void => {
    let m = bal.get(a);
    if (!m) { m = new Map(); bal.set(a, m); }
    m.set(t, v);
  };

  const events: LedgerEvent[] = [];
  const emit = (
    kind: EventKind, from: string, to: string, token: TokenSpec, amount: bigint, logIndex: number,
  ): void => {
    const i = events.length;
    events.push({
      chainId: token.chainId,
      txHash: `0x${i.toString(16).padStart(64, '0')}`,
      logIndex,
      eventKind: kind,
      tokenId: token.tokenId,
      amountRaw: amount,
      fromAddr: from,
      toAddr: to,
      blockNumber: i + 1,
      blockTime: new Date(BASE_TIME + i * 1000),
    });
  };

  const nativeOf = (chainId: number): TokenSpec =>
    tokens.find((t) => t.standard === 'native' && t.chainId === chainId)!;

  const transferKind = (t: TokenSpec): EventKind =>
    t.standard === 'native' ? 'native_transfer' : 'erc20_transfer';
  const transferLog = (t: TokenSpec): number => (t.standard === 'native' ? -1 : 0);

  // Seed one inflow so at least one owned wallet starts with a balance.
  {
    const t = tokens[0]!;
    const to = owned[0]!;
    emit(transferKind(t), external[0]!, to, t, seed.ops[0]!.inAmount, transferLog(t));
    set(to, t.tokenId, get(to, t.tokenId) + seed.ops[0]!.inAmount);
  }

  for (const op of seed.ops) {
    const token = tokens[op.tokenIdx % tokens.length]!;
    switch (op.kind) {
      case 0: { // external inflow
        const to = owned[op.toIdx % owned.length]!;
        emit(transferKind(token), external[op.fromIdx % external.length]!, to, token, op.inAmount, transferLog(token));
        set(to, token.tokenId, get(to, token.tokenId) + op.inAmount);
        break;
      }
      case 1: { // external outflow
        const from = owned[op.fromIdx % owned.length]!;
        const amount = clampSpend(get(from, token.tokenId), op.frac);
        if (amount === 0n) break;
        emit(transferKind(token), from, external[op.toIdx % external.length]!, token, amount, transferLog(token));
        set(from, token.tokenId, get(from, token.tokenId) - amount);
        break;
      }
      case 2: { // internal transfer (owned -> owned)
        if (owned.length < 2) break;
        const from = owned[op.fromIdx % owned.length]!;
        let to = owned[op.toIdx % owned.length]!;
        if (to === from) to = owned[(op.toIdx + 1) % owned.length]!;
        const amount = clampSpend(get(from, token.tokenId), op.frac);
        if (amount === 0n) break;
        emit(transferKind(token), from, to, token, amount, transferLog(token));
        set(from, token.tokenId, get(from, token.tokenId) - amount);
        set(to, token.tokenId, get(to, token.tokenId) + amount);
        break;
      }
      default: { // gas: native token of some chain, paid by an owned wallet
        const native = nativeOf(token.chainId);
        const from = owned[op.fromIdx % owned.length]!;
        const amount = clampSpend(get(from, native.tokenId), op.frac);
        if (amount === 0n) break;
        emit('gas_fee', from, ZERO, native, amount, -2);
        set(from, native.tokenId, get(from, native.tokenId) - amount);
        break;
      }
    }
  }

  return { events, owned, external, tokens, chainIds };
}

export const arbWorld: fc.Arbitrary<World> = fc
  .record({
    numOwned: fc.integer({ min: 1, max: 4 }),
    numExternal: fc.integer({ min: 1, max: 4 }),
    numChains: fc.integer({ min: 1, max: 2 }),
    numErc20: fc.integer({ min: 0, max: 3 }),
    ops: fc.array(opSeed, { minLength: 1, maxLength: 60 }),
  })
  .map(build);

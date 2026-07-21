import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { createLogger } from '@pet-crypto/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderBundle } from '../src/providers/provider-factory.js';
import type { ChainDataProvider, RawErc20Transfer, RawNativeTx, RawReceipt } from '../src/types.js';
import type { ProcessorDeps } from '../src/processors/ingest.js';
import { getCheckpoint, seedCheckpoint } from '../src/write/checkpoint-repo.js';
import { runBackfillPage } from '../src/processors/backfill.js';
import { runTailTick } from '../src/processors/tail.js';

const ADDR = '0xaaa0000000000000000000000000000000000001';
const DEST = '0xbbb0000000000000000000000000000000000002';
// erc20 contract — built via slice so it is guaranteed 40 hex (0x + 40) and
// lowercase, which pad()/topicAddr() round-tripping depends on.
const TOKEN = ('0x' + 'ccc' + '0'.repeat(40)).slice(0, 42);
// keccak256("Transfer(address,address,uint256)") — assignErc20Metadata matches on it.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const nativeTx = (block: number): RawNativeTx => ({
  blockNumber: String(block), timeStamp: '1700000000', hash: `0xtx${String(block)}`,
  from: ADDR, to: DEST, value: '1000', gasUsed: '21000', gasPrice: '2', isError: '0',
});

// 32-byte topic form of a 20-byte address; topicAddr() takes the low 20 bytes back.
const pad = (addr: string): string => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
const hex = (n: number): string => '0x' + n.toString(16);

const erc20Row = (block: number, hash: string): RawErc20Transfer => ({
  blockNumber: String(block), timeStamp: '1700000000', hash,
  logIndex: null, from: ADDR, to: DEST, contractAddress: TOKEN,
  value: '500', tokenName: 'Acme Token', tokenSymbol: 'ACME', tokenDecimal: '6',
});
// Receipt carrying the Transfer log assignErc20Metadata derives logIndex from,
// plus tx-level from/to (→ chain_events.tx_from/tx_to).
const erc20Receipt = (hash: string): RawReceipt => ({
  transactionHash: hash, from: ADDR, to: TOKEN,
  gasUsed: '50000', effectiveGasPrice: '2', l1Fee: null, status: '1',
  logs: [{ logIndex: 5, address: TOKEN, topics: [TRANSFER_TOPIC, pad(ADDR), pad(DEST)], data: hex(500) }],
});

type NativeFn = ChainDataProvider['getNativeTxs'];
type Erc20Fn = ChainDataProvider['getErc20Transfers'];
type ReceiptsFn = ProviderBundle['getReceipts'];

const bundleOf = (opts: { native?: NativeFn; erc20?: Erc20Fn; receipts?: ReceiptsFn }): ProviderBundle => ({
  indexer: {
    kind: 'etherscan-v2',
    getHead: async () => 1_000_000n,
    getNativeTxs: opts.native ?? (async () => ({ items: [] })),
    getErc20Transfers: opts.erc20 ?? (async () => ({ items: [] })),
  },
  getReceipts: opts.receipts ?? (async () => []),
});

// safeHead for chain 1 = head(1_000_000) − finalityDepth(64) = 999_936.
const SAFE = 999_936;

// Short native page: 3 txs at 100–102, then empty ⇒ one page, straight to live.
const nativeShort: NativeFn = async (q) => ({
  items: Number(q.fromBlock) <= 100 ? [nativeTx(100), nativeTx(101), nativeTx(102)] : [],
});
// Full native page: exactly PAGE_LIMIT (1000) txs at blocks 1..1000.
const bigTxs = Array.from({ length: 1000 }, (_, i) => nativeTx(i + 1));
const nativeFull: NativeFn = async (q) => {
  const from = Number(q.fromBlock);
  return { items: bigTxs.filter((t) => Number(t.blockNumber) >= from).slice(0, 1000) };
};
// A full page (PAGE_LIMIT) of relevant txs all in ONE block (500) — the
// degenerate case block-granular overlap pagination cannot advance past.
const spamBlock = Array.from({ length: 1000 }, (_, i) => ({ ...nativeTx(500), hash: `0xspam${i.toString(16)}` }));
const nativeSpamBlock: NativeFn = async (q) => ({ items: Number(q.fromBlock) <= 500 ? spamBlock : [] });
// A single tx at block 500 (for the tail tick).
const nativeAt500: NativeFn = async (q) => ({ items: Number(q.fromBlock) <= 500 ? [nativeTx(500)] : [] });
// One erc20 transfer at block 200, with matching receipts.
const erc20At200: Erc20Fn = async (q) => ({ items: Number(q.fromBlock) <= 200 ? [erc20Row(200, '0xerc1')] : [] });
const erc20Receipts: ReceiptsFn = async (hashes) => hashes.map((h) => erc20Receipt(h));

describe('processors', () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let pool: Pool;

  const deps = (bundle: () => ProviderBundle): ProcessorDeps => ({
    db, bundleFor: () => bundle(), logger: createLogger({ name: 'test' }),
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    db = createDb(pool);
  }, 120_000);
  afterAll(async () => { await pool.end(); await container.stop(); });

  // Each test starts from an empty ledger and a known cursor. TRUNCATE ... CASCADE
  // because matches.chain_event_id FKs chain_events.id (matches is empty here).
  const reset = async (stream: 'native' | 'erc20', block: number, status: string): Promise<void> => {
    // Truncate checkpoints too so a leftover stream from a prior test can't be
    // incidentally re-processed (e.g. by runTailTick's chain-wide scan).
    await pool.query('TRUNCATE chain_events, ingestion_checkpoints CASCADE');
    await seedCheckpoint(db, 1, ADDR, stream);
    await pool.query(
      `UPDATE ingestion_checkpoints SET last_processed_block=$1, status=$2 WHERE chain_id=1 AND address=$3 AND stream=$4`,
      [block, status, ADDR, stream],
    );
  };
  const kinds = async (): Promise<Record<string, number>> => {
    const { rows } = await pool.query('SELECT event_kind, count(*)::int AS n FROM chain_events GROUP BY event_kind');
    return Object.fromEntries(rows.map((r) => [r.event_kind as string, r.n as number]));
  };
  const snapshot = async (): Promise<string> =>
    (await pool.query('SELECT tx_hash, log_index, amount_raw FROM chain_events ORDER BY tx_hash, log_index'))
      .rows.map((r) => `${r.tx_hash}:${String(r.log_index)}:${r.amount_raw}`).join('|');

  it('ingests native + gas events and reaches live', async () => {
    await reset('native', 0, 'queued');
    const res = await runBackfillPage(deps(() => bundleOf({ native: nativeShort })), { chainId: 1, address: ADDR, stream: 'native' });
    expect(res.status).toBe('live');
    expect(res.inserted).toBe(6);
    const byKind = await kinds();
    expect(byKind.native_transfer).toBe(3);
    expect(byKind.gas_fee).toBe(3);
  });

  it('inv.5 — re-ingesting the same window is byte-identical and inserts nothing new', async () => {
    await reset('native', 0, 'queued');
    const bundle = (): ProviderBundle => bundleOf({ native: nativeShort });
    await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
    const first = await snapshot();
    // Rewind the cursor (keep the events) and re-run the SAME window through the
    // processor — the overlap must dedup via ON CONFLICT DO NOTHING (ADR-005).
    await pool.query(
      `UPDATE ingestion_checkpoints SET last_processed_block=0, status='queued' WHERE chain_id=1 AND address=$1 AND stream='native'`,
      [ADDR],
    );
    const again = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
    expect(again.inserted).toBe(0);
    expect(await snapshot()).toBe(first);
  });

  it('full page stays backfilling (cursor = last − 1), then the overlapped boundary block dedups', async () => {
    await reset('native', 0, 'queued');
    const bundle = (): ProviderBundle => bundleOf({ native: nativeFull });
    const res1 = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
    expect(res1.status).toBe('backfilling');
    expect(res1.lastProcessedBlock).toBe(999); // 1000 − 1: re-fetch the boundary next page
    expect(res1.inserted).toBe(2000); // 1000 native_transfer + 1000 gas_fee
    const res2 = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
    expect(res2.status).toBe('live');
    expect(res2.inserted).toBe(0); // boundary block 1000 re-fetched, all rows dedup
    const byKind = await kinds();
    expect(byKind.native_transfer).toBe(1000);
    expect(byKind.gas_fee).toBe(1000);
  });

  it('erc20 stream: receipt-derived logIndex, unverified token upsert, tx-level from/to', async () => {
    await reset('erc20', 0, 'queued');
    const res = await runBackfillPage(
      deps(() => bundleOf({ erc20: erc20At200, receipts: erc20Receipts })),
      { chainId: 1, address: ADDR, stream: 'erc20' },
    );
    expect(res.status).toBe('live');
    expect(res.inserted).toBe(1);
    expect(res.unseenContracts).toEqual([TOKEN]);
    const ev = (await pool.query(
      `SELECT event_kind, log_index, from_addr, to_addr, tx_from, tx_to FROM chain_events WHERE event_kind='erc20_transfer'`,
    )).rows[0];
    expect(ev).toMatchObject({
      event_kind: 'erc20_transfer', log_index: 5, from_addr: ADDR, to_addr: DEST, tx_from: ADDR, tx_to: TOKEN,
    });
    const tok = (await pool.query(
      `SELECT standard, verified, symbol_raw, name_raw, decimals FROM tokens WHERE chain_id=1 AND address=$1`, [TOKEN],
    )).rows[0];
    expect(tok).toEqual({ standard: 'erc20', verified: false, symbol_raw: 'ACME', name_raw: 'Acme Token', decimals: 6 });
  });

  it('runTailTick advances a live stream up to safeHead', async () => {
    await reset('native', 499, 'live'); // cursor just below the pending tx at block 500
    await runTailTick(deps(() => bundleOf({ native: nativeAt500 })), { chainId: 1 });
    const byKind = await kinds();
    expect(byKind.native_transfer).toBe(1);
    expect(byKind.gas_fee).toBe(1);
    const cp = await getCheckpoint(db, 1, ADDR, 'native');
    expect(cp).toMatchObject({ status: 'live', lastProcessedBlock: SAFE });
  });

  it('never queries the provider past safeHead (ADR-005 fast-path)', async () => {
    // Cursor already at safeHead ⇒ fromBlock = safe + 1 > safe. The provider mock
    // throws if queried, so this test fails if the `fromBlock > safe` guard is removed.
    await reset('native', SAFE, 'live');
    const throwIfQueried: NativeFn = async () => { throw new Error('provider queried past safeHead'); };
    const res = await runBackfillPage(
      deps(() => bundleOf({ native: throwIfQueried })),
      { chainId: 1, address: ADDR, stream: 'native' },
    );
    expect(res.status).toBe('live');
    expect(res.inserted).toBe(0);
    expect(res.lastProcessedBlock).toBe(SAFE);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chain_events');
    expect(rows[0].n).toBe(0);
  });

  it('fails loudly when one block holds a full page of relevant txs (no forward progress)', async () => {
    // Cursor at 499 ⇒ fromBlock = 500; the page is 1000 items all in block 500 ⇒
    // newCursor = 500 − 1 = 499 = the current cursor. Overlap-by-one can't split a
    // block, so re-fetching would loop forever — ingestOnce must throw, not spin.
    await reset('native', 499, 'backfilling');
    await expect(
      runBackfillPage(deps(() => bundleOf({ native: nativeSpamBlock })), { chainId: 1, address: ADDR, stream: 'native' }),
    ).rejects.toThrow(/stalled|cannot advance/i);
    // Nothing committed; the cursor did not move (the whole page is one transaction).
    expect((await getCheckpoint(db, 1, ADDR, 'native'))?.lastProcessedBlock).toBe(499);
    expect((await pool.query('SELECT count(*)::int AS n FROM chain_events')).rows[0].n).toBe(0);
  });

  it('tail: a live stream over a >PAGE_LIMIT gap is handed back for backfill, then recovers', async () => {
    // A live stream with a large window ahead (e.g. post-downtime). The tick's
    // first page is full (1000) ⇒ ingestOnce flips it to 'backfilling'.
    await reset('native', 0, 'live');
    const bundle = (): ProviderBundle => bundleOf({ native: nativeFull });
    const stragglers = await runTailTick(deps(bundle), { chainId: 1 });
    // Tail must return it so the host enqueues a backfill page — otherwise the
    // status='live' filter would exclude it from every future tick and it strands.
    expect(stragglers).toEqual([{ chainId: 1, address: ADDR, stream: 'native' }]);
    expect((await getCheckpoint(db, 1, ADDR, 'native'))?.status).toBe('backfilling');
    // Draining via backfill (what the host does with the returned target) recovers to live.
    let res = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
    while (res.status === 'backfilling') {
      res = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
    }
    expect((await getCheckpoint(db, 1, ADDR, 'native'))?.status).toBe('live');
    expect((await kinds()).native_transfer).toBe(1000);
  });
});

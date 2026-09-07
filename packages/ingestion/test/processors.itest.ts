import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, type Db } from '@reconcil/db';
import { createLogger } from '@reconcil/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderBundle } from '../src/providers/provider-factory.js';
import type {
  ChainDataProvider,
  RawErc20Transfer,
  RawInternalTx,
  RawNativeTx,
  RawReceipt,
} from '../src/types.js';
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

// One trace-level ETH inflow (txlistinternal): no gas fields, `traceId` orders the
// traces that share a parent tx (see normalize()).
const internalTx = (
  block: number, hash: string, traceId: string | undefined, value = '400',
): RawInternalTx => ({
  blockNumber: String(block), timeStamp: '1700000000', hash,
  from: DEST, to: ADDR, value, isError: '0', traceId,
});

type NativeFn = ChainDataProvider['getNativeTxs'];
type InternalFn = NonNullable<ChainDataProvider['getInternalTxs']>;
type Erc20Fn = ChainDataProvider['getErc20Transfers'];
type ReceiptsFn = ProviderBundle['getReceipts'];

const bundleOf = (opts: {
  native?: NativeFn; internal?: InternalFn; erc20?: Erc20Fn; receipts?: ReceiptsFn; head?: bigint;
}): ProviderBundle => ({
  indexer: {
    kind: 'etherscan-v2',
    getHead: async () => opts.head ?? 1_000_000n,
    getNativeTxs: opts.native ?? (async () => ({ items: [] })),
    getErc20Transfers: opts.erc20 ?? (async () => ({ items: [] })),
    // Optional capability (ADR-009): only present when the case supplies one, so
    // every pre-existing case still exercises the txlist-only degradation path.
    ...(opts.internal ? { getInternalTxs: opts.internal } : {}),
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
// Short internal page: 2 traces of ONE parent tx at block 103.
const internalShort: InternalFn = async (q) => ({
  items: Number(q.fromBlock) <= 103
    ? [internalTx(103, '0xint1', '0'), internalTx(103, '0xint1', '1', '900')]
    : [],
});
// Full internal page: exactly PAGE_LIMIT traces, 2 per parent tx over blocks 200..699.
const bigInternals = Array.from({ length: 1000 }, (_, i) =>
  internalTx(200 + Math.floor(i / 2), `0xint${String(Math.floor(i / 2))}`, String(i % 2)));
const internalFull: InternalFn = async (q) => {
  const from = Number(q.fromBlock);
  return { items: bigInternals.filter((t) => Number(t.blockNumber) >= from).slice(0, 1000) };
};
// A full internal page packed into ONE block (300) — 500 parent txs × 2 traces.
const internalSpamBlock: InternalFn = async (q) => ({
  items: Number(q.fromBlock) <= 300
    ? Array.from({ length: 1000 }, (_, i) =>
        internalTx(300, `0xflood${String(Math.floor(i / 2))}`, String(i % 2)))
    : [],
});
// The mid-tx truncation hazard, worst case. One parent tx at block 1299 carries three
// traces whose stable rank DEPENDS ON THE SET: '0xsplit' mixes a labelled trace with an
// unlabelled one, so the whole-tx fetch ranks by the (from,to,value) tuple
// (100 → −1000, 500 → −1001, 900 → −1002) while a page truncated after the first trace
// would rank that trace alone by its label (900 → −1000). Storing the truncated page
// would therefore drop the 100-wei trace on conflict AND re-insert the 900-wei one at a
// second sentinel. 999 single-trace fillers put the cut exactly there.
const SPLIT_BLOCK = 1299;
const splitTraces: RawInternalTx[] = [
  internalTx(SPLIT_BLOCK, '0xsplit', '5', '900'),
  internalTx(SPLIT_BLOCK, '0xsplit', undefined, '100'),
  internalTx(SPLIT_BLOCK, '0xsplit', '1', '500'),
];
const splitFillers = Array.from({ length: 999 }, (_, i) =>
  internalTx(300 + i, `0xfill${String(i)}`, '0'));
const internalSplitTx: InternalFn = async (q) => {
  const from = Number(q.fromBlock);
  return {
    items: [...splitFillers, ...splitTraces].filter((t) => Number(t.blockNumber) >= from).slice(0, 1000),
  };
};
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

  // Captures warn() calls so H7's "skip, don't regress" branch can assert it logged
  // instead of silently swallowing the stale/negative-safe condition.
  const warnLog: { msg: string; fields?: Record<string, unknown> }[] = [];
  const depsWithWarnSpy = (bundle: () => ProviderBundle): ProcessorDeps => ({
    db,
    bundleFor: () => bundle(),
    logger: {
      info: () => {},
      warn: (msg, fields) => { warnLog.push({ msg, fields }); },
      error: () => {},
    },
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

  it('full page stays backfilling (cursor = last − 1), then the withheld boundary block lands on the next page', async () => {
    await reset('native', 0, 'queued');
    const bundle = (): ProviderBundle => bundleOf({ native: nativeFull });
    const res1 = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
    expect(res1.status).toBe('backfilling');
    expect(res1.lastProcessedBlock).toBe(999); // 1000 − 1: re-fetch the boundary next page
    // Blocks 1..999 only (999 transfers + 999 gas): a page cut can end mid-block, so
    // nothing above the new cursor is stored — the boundary block waits for the
    // re-fetch that sees it whole.
    expect(res1.inserted).toBe(1998);
    const res2 = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
    expect(res2.status).toBe('live');
    expect(res2.inserted).toBe(2); // block 1000's transfer + gas, stored exactly once
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

  // H7 — a stale (load-balanced) provider head must never regress the cursor, and a
  // fresh/dev chain whose head is below finalityDepth must never write a negative one.
  describe('H7 — cursor never regresses or goes negative', () => {
    it('stale head (safe < cursor): skips the commit, cursor stays put, status unchanged, warns with numbers only', async () => {
      warnLog.length = 0;
      await reset('native', 1000, 'live');
      // head 990 ⇒ safe = 990 − 64 finalityDepth(chain 1) is actually below — use a head
      // that keeps safe itself already below the cursor without going through finalityDepth
      // arithmetic surprises: head 1000, finalityDepth 64 ⇒ safe = 936 < cursor 1000.
      const res = await runBackfillPage(
        depsWithWarnSpy(() => bundleOf({ native: () => { throw new Error('must not query when regressed'); }, head: 1000n })),
        { chainId: 1, address: ADDR, stream: 'native' },
      );
      expect(res).toEqual({ status: 'live', lastProcessedBlock: 1000, inserted: 0, unseenContracts: [] });
      const cp = await getCheckpoint(db, 1, ADDR, 'native');
      expect(cp).toMatchObject({ status: 'live', lastProcessedBlock: 1000 });
      expect(warnLog).toHaveLength(1);
      expect(warnLog[0]!.fields).toMatchObject({ chainId: 1, address: ADDR, stream: 'native', safe: 936, lastProcessedBlock: 1000 });
      // no provider text anywhere in the logged message/fields
      expect(JSON.stringify(warnLog[0])).not.toMatch(/provider|rpc|http/i);
    });

    it('preserves a backfilling status (not silently flipped to live) on the skip path', async () => {
      warnLog.length = 0;
      await reset('native', 1000, 'backfilling');
      const res = await runBackfillPage(
        depsWithWarnSpy(() => bundleOf({ native: () => { throw new Error('must not query when regressed'); }, head: 1000n })),
        { chainId: 1, address: ADDR, stream: 'native' },
      );
      expect(res.status).toBe('backfilling');
      expect(res.lastProcessedBlock).toBe(1000);
      const cp = await getCheckpoint(db, 1, ADDR, 'native');
      expect(cp).toMatchObject({ status: 'backfilling', lastProcessedBlock: 1000 });
    });

    it('negative safe (fresh/dev chain: head < finalityDepth): skips the commit, never writes a negative cursor, reports the stored status exactly (queued, not coerced to live)', async () => {
      warnLog.length = 0;
      await reset('native', 0, 'queued');
      // head 3, finalityDepth 64 (chain 1) ⇒ safe = -61.
      const res = await runBackfillPage(
        depsWithWarnSpy(() => bundleOf({ native: () => { throw new Error('must not query when regressed'); }, head: 3n })),
        { chainId: 1, address: ADDR, stream: 'native' },
      );
      expect(res.status).toBe('queued');
      expect(res.lastProcessedBlock).toBe(0);
      expect(res.inserted).toBe(0);
      const cp = await getCheckpoint(db, 1, ADDR, 'native');
      expect(cp).toMatchObject({ status: 'queued', lastProcessedBlock: 0 });
      expect(cp?.lastProcessedBlock).toBeGreaterThanOrEqual(0);
      expect(warnLog).toHaveLength(1);
      expect(warnLog[0]!.fields).toMatchObject({ safe: -61, lastProcessedBlock: 0 });
    });

    it('legitimate empty advance is preserved: safe > cursor with no items still advances the cursor to safe', async () => {
      await reset('native', 1000, 'live');
      // head 1114, finalityDepth 64 (chain 1) ⇒ safe = 1050, comfortably above cursor 1000.
      const res = await runBackfillPage(
        deps(() => bundleOf({ native: async () => ({ items: [] }), head: 1114n })),
        { chainId: 1, address: ADDR, stream: 'native' },
      );
      expect(res).toEqual({ status: 'live', lastProcessedBlock: 1050, inserted: 0, unseenContracts: [] });
      const cp = await getCheckpoint(db, 1, ADDR, 'native');
      expect(cp).toMatchObject({ status: 'live', lastProcessedBlock: 1050 });
    });
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

  // The `native` checkpoint stream covers txlist AND txlistinternal (ADR-005 d2):
  // one cursor, two provider pages. It must never advance past a block whose
  // internal transfers were truncated — chain_events is append-only and nothing
  // ever revisits a passed block.
  describe('internal transfers on the native stream', () => {
    const internalRows = async (): Promise<{ tx: string; idx: number; amt: string }[]> =>
      (await pool.query(
        'SELECT tx_hash, log_index, amount_raw FROM chain_events WHERE log_index <= -1000 ORDER BY tx_hash, log_index DESC',
      )).rows.map((r) => ({ tx: r.tx_hash as string, idx: r.log_index as number, amt: r.amount_raw as string }));
    const internalCount = async (): Promise<number> =>
      (await pool.query('SELECT count(*)::int AS n FROM chain_events WHERE log_index <= -1000')).rows[0].n as number;

    it('ingests txlistinternal alongside txlist in one page (the R3 inflows txlist omits)', async () => {
      await reset('native', 0, 'queued');
      const res = await runBackfillPage(
        deps(() => bundleOf({ native: nativeShort, internal: internalShort })),
        { chainId: 1, address: ADDR, stream: 'native' },
      );
      expect(res.status).toBe('live');
      expect(res.lastProcessedBlock).toBe(SAFE); // both pages short ⇒ straight to safeHead
      expect(res.inserted).toBe(8); // 3 native_transfer + 3 gas_fee + 2 internal
      const byKind = await kinds();
      expect(byKind.native_transfer).toBe(5);
      expect(byKind.gas_fee).toBe(3); // internal transfers synthesize no gas
      expect(await internalRows()).toEqual([
        { tx: '0xint1', idx: -1000, amt: '400' },
        { tx: '0xint1', idx: -1001, amt: '900' },
      ]);
    });

    it('degrades to txlist-only when no provider serves the capability (ADR-009)', async () => {
      await reset('native', 0, 'queued');
      const res = await runBackfillPage(
        deps(() => bundleOf({ native: nativeShort })),
        { chainId: 1, address: ADDR, stream: 'native' },
      );
      expect(res.status).toBe('live');
      expect(await internalCount()).toBe(0);
    });

    it('a full internal page caps the cursor at internal-last − 1 and holds the stream backfilling, even though the native page was short', async () => {
      await reset('native', 0, 'queued');
      const bundle = (): ProviderBundle => bundleOf({ native: nativeShort, internal: internalFull });
      const res1 = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
      // The native page alone would have said "safe, live"; the truncated internal
      // page pulls the shared cursor back to its own boundary block − 1.
      expect(res1.status).toBe('backfilling');
      expect(res1.lastProcessedBlock).toBe(698); // internal page ends at block 699
      // 6 native/gas + 998 internal: block 699's two traces sit ABOVE the new cursor
      // and are withheld — a page cut can end mid-tx, and a partially-fetched tx must
      // never be stored under ranks derived from a partial trace set.
      expect(res1.inserted).toBe(1004);
      // Next page re-fetches block 699 whole and stores it then.
      const res2 = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
      expect(res2.status).toBe('live');
      expect(res2.lastProcessedBlock).toBe(SAFE);
      expect(res2.inserted).toBe(2);
      expect(await internalCount()).toBe(1000); // every trace stored exactly once
    });

    it('when both pages are full the cursor is the MINIMUM of the two candidates', async () => {
      await reset('native', 0, 'queued');
      const res = await runBackfillPage(
        deps(() => bundleOf({ native: nativeFull, internal: internalFull })),
        { chainId: 1, address: ADDR, stream: 'native' },
      );
      // native page ends at 1000 (candidate 999), internal at 699 (candidate 698).
      expect(res.status).toBe('backfilling');
      expect(res.lastProcessedBlock).toBe(698);
    });

    // Regression: the mid-tx truncation hazard. Without the "never store past the
    // cursor" rule this loses one trace and double-counts another — silently.
    it('a page cut mid-transaction stores nothing of that tx until the re-fetch sees it whole', async () => {
      await reset('native', 0, 'queued');
      const bundle = (): ProviderBundle => bundleOf({ internal: internalSplitTx });
      const res1 = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
      expect(res1.status).toBe('backfilling');
      expect(res1.lastProcessedBlock).toBe(SPLIT_BLOCK - 1);
      expect(res1.inserted).toBe(999); // the fillers only — the split tx is withheld
      expect(await pool.query('select count(*)::int as n from chain_events where tx_hash = $1', ['0xsplit']))
        .toMatchObject({ rows: [{ n: 0 }] });

      const res2 = await runBackfillPage(deps(bundle), { chainId: 1, address: ADDR, stream: 'native' });
      expect(res2.status).toBe('live');
      expect(res2.inserted).toBe(3);

      // The union of what is stored equals the complete single-fetch result: three
      // rows, three distinct sentinels, each amount present exactly once.
      const stored = (await pool.query(
        'select log_index, amount_raw from chain_events where tx_hash = $1 order by log_index desc',
        ['0xsplit'],
      )).rows.map((r) => [r.log_index as number, r.amount_raw as string]);
      expect(stored).toEqual([[-1000, '100'], [-1001, '500'], [-1002, '900']]);
      expect(new Set(stored.map(([idx]) => idx)).size).toBe(3); // no collisions
      // and no value invented or lost: Σ stored === Σ the provider's traces
      expect(stored.reduce((s, [, amt]) => s + BigInt(amt as string), 0n))
        .toBe(splitTraces.reduce((s, t) => s + BigInt(t.value), 0n));
      expect(await internalCount()).toBe(1002);
    });

    it('fails loudly when one block holds a full page of internal transfers (same as native)', async () => {
      await reset('native', 299, 'backfilling');
      await expect(
        runBackfillPage(
          deps(() => bundleOf({ native: async () => ({ items: [] }), internal: internalSpamBlock })),
          { chainId: 1, address: ADDR, stream: 'native' },
        ),
      ).rejects.toThrow(/stalled|cannot advance/i);
      expect((await getCheckpoint(db, 1, ADDR, 'native'))?.lastProcessedBlock).toBe(299);
      expect((await pool.query('SELECT count(*)::int AS n FROM chain_events')).rows[0].n).toBe(0);
    });

    it('opstack receipts stay driven by the NATIVE page alone — an internal transfer has no gas of its own', async () => {
      await pool.query('TRUNCATE chain_events, ingestion_checkpoints CASCADE');
      await seedCheckpoint(db, 8453, ADDR, 'native'); // Base: feeStrategy receipts-opstack
      const asked: string[] = [];
      const receipts: ReceiptsFn = async (hashes) => {
        asked.push(...hashes);
        return hashes.map((h) => ({
          transactionHash: h, from: ADDR, to: DEST,
          gasUsed: '50000', effectiveGasPrice: '2', l1Fee: '7', status: '1' as const, logs: [],
        }));
      };
      const res = await runBackfillPage(
        deps(() => bundleOf({ native: nativeShort, internal: internalShort, receipts })),
        { chainId: 8453, address: ADDR, stream: 'native' },
      );
      expect(asked).toEqual(['0xtx100', '0xtx101', '0xtx102']);
      expect(asked).not.toContain('0xint1');
      expect(res.inserted).toBe(8);
      expect((await kinds()).gas_fee).toBe(3);
    });
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

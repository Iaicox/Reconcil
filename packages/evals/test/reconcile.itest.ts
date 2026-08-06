import { createLogger } from '@reconcil/core';
import { createDb, runMigrations, type Db } from '@reconcil/db';
import { runBackfillPage, seedCheckpoint } from '@reconcil/ingestion';
import { computeBalances } from '@reconcil/ledger';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { goldenIngestFixture, recordedNativeBalance, seedGoldenWallet } from '../src/seed.js';

// Frozen anchors for the freelancer wallet (0x6eb804cb…) on chain 1, from the recorded
// fixtures captured at block 25552177 (the manifest toBlock):
//   RECORDED — provider eth_get_balance (0x79f8edae84b66), the true on-chain balance.
//   TXLIST   — computeBalances over the replayed txlist ALONE (Σ in − out − gas). It goes
//              NEGATIVE: the wallet's ETH inflows arrive largely via contract-internal
//              transfers (exchange withdrawals) that txlist omits (the R3 gap,
//              05-risks-open-questions.md R3). The `txlistinternal` stream (ADR-005 d2)
//              supplies exactly those inflows, so the pipeline (replay → normalize → write
//              → ledger) now reconciles the native balance to RECORDED *to the wei* — the
//              R3 integrity check the design mandated (04-testing.md §2, unblocker b).
//   INTERNAL_INFLOWS — the closed gap: 5 internal transfers, one of 0.15731877 ETH plus
//              four 1-gwei dust refunds, summing to RECORDED − TXLIST.
const RECORDED = 2_145_760_743_803_750n;
const TXLIST = -155_173_013_256_196_250n;
const INTERNAL_INFLOWS = RECORDED - TXLIST; // 157_318_774_000_000_000n

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  db = createDb(pool);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

// Each case seeds from a clean slate — seedGoldenWallet inserts the native token
// unconditionally, and tokens has unique(chain_id, address) nullsNotDistinct, so a
// second seed without truncation would collide.
beforeEach(async () => {
  await pool.query('TRUNCATE chain_events, tokens, ingestion_checkpoints RESTART IDENTITY CASCADE');
});

describe('golden-wallet reconciliation (freelancer, chain 1, native+internal+gas)', () => {
  it('seeds txlist+txlistinternal+gas and reconciles the native balance to eth_get_balance', async () => {
    const seeded = await seedGoldenWallet(db, 'freelancer', 1);
    expect(seeded.nativeTransfers).toBeGreaterThan(0);
    expect(seeded.internalTransfers).toBe(5);
    expect(seeded.gasFees).toBeGreaterThan(0);

    const res = await computeBalances(db, { scope: { addresses: [seeded.address] } });
    const nativeRow = res.rows.find((r) => r.token.tokenId === seeded.nativeTokenId);
    expect(nativeRow).toBeDefined();
    const computed = BigInt(nativeRow!.amountRaw);

    // R3 closed: the computed balance now equals the provider-attested truth exactly.
    const recorded = await recordedNativeBalance('freelancer', 1, seeded.toBlock);
    expect(recorded).toBe(RECORDED);
    expect(computed).toBe(recorded);
  });

  it('the txlistinternal stream supplies exactly the inflows txlist omits (the closed R3 gap)', async () => {
    const seeded = await seedGoldenWallet(db, 'freelancer', 1);

    // Sum the internal-transfer inflows directly from the store (sentinel log_index ≤ −1000):
    // they are precisely RECORDED − TXLIST, the amount txlist alone could not see.
    const { rows } = await pool.query<{ sum: string | null }>(
      `select sum(amount_raw)::text as sum from chain_events
         where log_index <= -1000 and lower(to_addr) = lower($1)`,
      [seeded.address],
    );
    expect(BigInt(rows[0]?.sum ?? '0')).toBe(INTERNAL_INFLOWS);
  });
});

// The two cases above replay the fixtures through the seed harness's own loop. This
// one runs the SAME wallet through the code the worker actually executes — checkpoint
// → ingestOnce (txlist + txlistinternal pages, cursor, status) → commitPage → ledger.
// Before internal transfers were wired into ingestOnce, the production path could not
// reach RECORDED at all: it saw txlist only, i.e. TXLIST (negative).
describe('golden-wallet reconciliation through the production ingestion path (ingestOnce)', () => {
  // includeUnverified on every computeBalances call below: the inline token upsert in
  // the ingestion write path writes even the native pseudo-token as verified=false
  // (the token-resolve slice that curates `verified` is deferred, write/token-repo.ts),
  // whereas seedGoldenWallet inserts it verified. Nothing to do with internal transfers.
  //
  // ::int — node-postgres hands BIGINT back as a string, and computeBalances keys
  // tokenId as a number.
  const nativeTokenId = async (): Promise<number> =>
    (await pool.query('select id::int as id from tokens where chain_id = 1 and address is null')).rows[0].id as number;
  const runOnePage = async (): Promise<{ status: string; lastProcessedBlock: number; inserted: number }> => {
    const fx = goldenIngestFixture('freelancer', 1);
    return runBackfillPage(
      { db, bundleFor: () => fx.bundle, logger: createLogger({ name: 'reconcile-itest' }) },
      { chainId: fx.chainId, address: fx.address, stream: 'native' },
    );
  };

  it('ingestOnce fetches both native pages and the folded balance equals eth_get_balance to the wei', async () => {
    const fx = goldenIngestFixture('freelancer', 1);
    await seedCheckpoint(db, fx.chainId, fx.address, 'native');

    const res = await runOnePage();
    // 208 txlist rows + 5 internal rows — both pages short, so one page reaches safeHead.
    expect(res.status).toBe('live');
    expect(res.lastProcessedBlock).toBe(Number(fx.safeBlock));

    const internal = await pool.query<{ n: number }>(
      'select count(*)::int as n from chain_events where log_index <= -1000',
    );
    expect(internal.rows[0]?.n).toBe(5); // the R3 inflows, via the production path

    const balances = await computeBalances(db, { scope: { addresses: [fx.address] }, includeUnverified: true });
    const tokenId = await nativeTokenId();
    const computed = BigInt(balances.rows.find((r) => r.token.tokenId === tokenId)!.amountRaw);
    expect(computed).toBe(await recordedNativeBalance('freelancer', 1, fx.safeBlock));
    expect(computed).toBe(RECORDED);
  });

  it('re-running the page inserts nothing and leaves the balance identical (append-only key)', async () => {
    const fx = goldenIngestFixture('freelancer', 1);
    await seedCheckpoint(db, fx.chainId, fx.address, 'native');
    await runOnePage();
    const tokenId = await nativeTokenId();
    const before = (await computeBalances(db, { scope: { addresses: [fx.address] }, includeUnverified: true }))
      .rows.find((r) => r.token.tokenId === tokenId)!.amountRaw;

    // Rewind the cursor only (keep the events) and re-ingest the same window: every
    // row — internal transfers included — must dedupe on (chain_id, tx_hash, log_index,
    // token_id), which is what the stable per-tx sentinel order buys.
    await pool.query(
      `update ingestion_checkpoints set last_processed_block = 0, status = 'queued'
         where chain_id = 1 and address = $1 and stream = 'native'`,
      [fx.address],
    );
    const again = await runOnePage();
    expect(again.inserted).toBe(0);
    const after = (await computeBalances(db, { scope: { addresses: [fx.address] }, includeUnverified: true }))
      .rows.find((r) => r.token.tokenId === tokenId)!.amountRaw;
    expect(after).toBe(before);
    expect(BigInt(after)).toBe(RECORDED);
  });
});

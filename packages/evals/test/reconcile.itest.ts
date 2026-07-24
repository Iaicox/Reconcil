import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { computeBalances } from '@pet-crypto/ledger';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { recordedNativeBalance, seedGoldenWallet } from '../src/seed.js';

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
  await pool.query('TRUNCATE chain_events, tokens RESTART IDENTITY CASCADE');
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

import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { computeBalances } from '@pet-crypto/ledger';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { recordedNativeBalance, seedGoldenWallet } from '../src/seed.js';

// Frozen anchors for the freelancer wallet (0x6eb804cb…) on chain 1, from the recorded
// fixtures captured at block 25552177 (the manifest toBlock):
//   RECORDED  — provider eth_get_balance (0x79f8edae84b66), the true on-chain balance.
//   TXLIST    — computeBalances over the replayed txlist (Σ in − out − gas). It goes
//               NEGATIVE: the wallet's ETH inflows arrive largely via contract-internal
//               transfers (e.g. exchange withdrawals) that txlist omits (the R3 gap,
//               05-risks-open-questions.md R3). So the txlist-only native balance is not
//               the true balance, and native ABSOLUTE reconciliation is blocked until a
//               `txlistinternal` stream or the network-gated receipts capture lands
//               (04-testing.md §2 unblockers a/b). Until then this itest pins the frozen
//               end-to-end result (replay → normalize → write → ledger) and quantifies
//               the missing-internal-inflow gap rather than asserting equality.
const RECORDED = 2_145_760_743_803_750n;
const TXLIST = -155_173_013_256_196_250n;

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

describe('golden-wallet reconciliation (freelancer, chain 1, native+gas)', () => {
  it('seeds native+gas through the real pipeline and computes a deterministic balance', async () => {
    const seeded = await seedGoldenWallet(db, 'freelancer', 1);
    expect(seeded.nativeTransfers).toBeGreaterThan(0);
    expect(seeded.gasFees).toBeGreaterThan(0);

    const res = await computeBalances(db, { scope: { addresses: [seeded.address] } });
    const nativeRow = res.rows.find((r) => r.token.tokenId === seeded.nativeTokenId);
    expect(nativeRow).toBeDefined();
    expect(BigInt(nativeRow!.amountRaw)).toBe(TXLIST);
  });

  it('quantifies the R3 internal-inflow gap against the recorded eth_get_balance', async () => {
    const seeded = await seedGoldenWallet(db, 'freelancer', 1);

    const res = await computeBalances(db, { scope: { addresses: [seeded.address] } });
    const computed = BigInt(res.rows.find((r) => r.token.tokenId === seeded.nativeTokenId)!.amountRaw);
    const recorded = await recordedNativeBalance('freelancer', 1, seeded.toBlock);

    expect(recorded).toBe(RECORDED);
    expect(computed).toBe(TXLIST);

    // Internal inflows missing from txlist can only RAISE the true balance above the
    // txlist-derived one — the gap is strictly positive and equals those inflows.
    expect(recorded > computed).toBe(true);
    expect(recorded - computed).toBe(RECORDED - TXLIST);
  });
});

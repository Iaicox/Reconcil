/**
 * H1 remediation proof (docs/architecture/03-ingestion.md §7): a fresh deployment must
 * not be empty everywhere. Runs the real migrations (including
 * packages/db/migrations/0002_seed_curated_tokens.sql) against a fresh, untouched
 * database — no test-fixture truncation/reinsertion of tokens here, unlike
 * ledger.itest.ts's seedWorld — and proves that a single settlement event against a
 * seeded curated token is visible through computeBalances with default flags (i.e.
 * includeUnverified absent), because the curated seed already shipped verified = true.
 */
import { chainEvents, createDb, runMigrations, tokens, type Db } from '@reconcil/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, isNull } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeBalances } from '../src/balances.js';

const OWNED = '0x0000000000000000000000000000000000000a01';
const EXT = '0x0000000000000000000000000000000000000e01';
const ETHEREUM_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

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

async function seededTokenId(chainId: number, address: string | null): Promise<number> {
  const addrCond = address === null ? isNull(tokens.address) : eq(tokens.address, address);
  const [row] = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.chainId, chainId), addrCond));
  if (!row) throw new Error(`expected the curated seed migration to have already inserted (chain ${String(chainId)}, address ${String(address)})`);
  return row.id;
}

describe('fresh deploy: curated seed makes ledger data visible by default', () => {
  it('a native-token transfer is visible via computeBalances with default flags (no includeUnverified)', async () => {
    const nativeTokenId = await seededTokenId(1, null);

    await db.insert(chainEvents).values({
      chainId: 1,
      txHash: `0x${'a1'.repeat(32)}`,
      logIndex: -1,
      eventKind: 'native_transfer',
      tokenId: nativeTokenId,
      amountRaw: 1_000_000_000_000_000_000n,
      fromAddr: EXT,
      toAddr: OWNED,
      blockNumber: 1,
      blockTime: new Date('2026-01-01T00:00:00Z'),
      txFrom: EXT,
      txTo: OWNED,
      provider: 'fixture',
      raw: {},
    });

    const res = await computeBalances(db, { scope: { addresses: [OWNED] } });
    const row = res.rows.find((r) => r.token.tokenId === nativeTokenId);
    expect(row).toBeDefined();
    expect(row?.amountRaw).toBe('1000000000000000000');
  });

  it('an Ethereum USDC transfer is visible via computeBalances with default flags (no includeUnverified)', async () => {
    const usdcTokenId = await seededTokenId(1, ETHEREUM_USDC);

    await db.insert(chainEvents).values({
      chainId: 1,
      txHash: `0x${'b2'.repeat(32)}`,
      logIndex: 0,
      eventKind: 'erc20_transfer',
      tokenId: usdcTokenId,
      amountRaw: 1_523_420_000n,
      fromAddr: EXT,
      toAddr: OWNED,
      blockNumber: 2,
      blockTime: new Date('2026-01-02T00:00:00Z'),
      txFrom: EXT,
      txTo: OWNED,
      provider: 'fixture',
      raw: {},
    });

    const res = await computeBalances(db, { scope: { addresses: [OWNED] } });
    const row = res.rows.find((r) => r.token.tokenId === usdcTokenId);
    expect(row).toBeDefined();
    expect(row?.amountRaw).toBe('1523420000');
    expect(row?.amount).toBe('1523.42');
  });
});

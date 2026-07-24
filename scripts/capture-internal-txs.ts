/**
 * One-time, network-gated capture of `txlistinternal` fixtures for the golden
 * wallets (04-testing.md §2 unblocker b; ADR-005 d2). Records the recorded
 * provider responses the eval seed harness replays — same Blockscout adapter +
 * paging the seed uses, so the URL→file names line up at replay time.
 *
 *   pnpm tsx scripts/capture-internal-txs.ts [role ...]   # default: every chain-1 role
 *
 * Blockscout is keyless; nothing to scrub, but assertScrubbed('') is a cheap
 * belt-and-suspenders. Re-runnable: overwrites the same frozen files. Commit them.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertScrubbed,
  blockscoutAdapter,
  collectAllPages,
  readManifest,
  realFetchJson,
  recordingTransport,
  type PageQuery,
} from '@pet-crypto/ingestion';

const CHAIN_ID = 1;
const FIXTURES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'packages',
  'evals',
  'fixtures',
  'providers',
);
const OUT_DIR = join(FIXTURES, 'blockscout', String(CHAIN_ID));

async function main(): Promise<void> {
  const manifest = readManifest(join(FIXTURES, 'manifest.json'));
  const requested = process.argv.slice(2);
  const roles = requested.length > 0 ? requested : manifest.map((w) => w.role);

  const provider = blockscoutAdapter({
    fetchJson: recordingTransport(realFetchJson(), OUT_DIR),
    baseUrl: 'https://eth.blockscout.com/api',
    chainId: CHAIN_ID,
  });

  for (const role of roles) {
    const entry = manifest.find((w) => w.role === role);
    const window = entry?.chains[String(CHAIN_ID)];
    if (!entry || !window) {
      console.error(`skip ${role}: no chain ${CHAIN_ID} in manifest`);
      continue;
    }
    const q: PageQuery = {
      chainId: CHAIN_ID,
      address: entry.address,
      fromBlock: BigInt(window.fromBlock),
      toBlock: BigInt(window.toBlock),
      limit: 1000,
      sort: 'asc',
    };
    const internal = await collectAllPages((pq) => provider.getInternalTxs!(pq), q);
    console.log(`${role} (${entry.address}): captured ${internal.length} internal txs`);
  }

  assertScrubbed(OUT_DIR, 'REDACTED_SENTINEL_NEVER_PRESENT');
  console.log(`fixtures written under ${OUT_DIR}`);
}

main().catch((err: unknown) => {
  console.error('capture failed:', err);
  process.exit(1);
});

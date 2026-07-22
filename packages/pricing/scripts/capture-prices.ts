/**
 * One-off price/FX fixture capture (ADR-007). Live network — never runs in CI or
 * tests. Derives the needs from DATABASE_URL's `chain_events` (exactly what the
 * worker's fill does) and records every DefiLlama/CoinGecko/ECB response via
 * recordingTransport, so recorded fixtures match what a replay would request.
 *
 *   pnpm --filter @pet-crypto/pricing capture       # DATABASE_URL from the env / root .env
 *
 * DefiLlama and ECB are keyless; COINGECKO_API_KEY (optional) raises the secondary
 * source's rate limits. Fixtures land in packages/evals/fixtures/providers/prices.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '@pet-crypto/core';
import { createDb } from '@pet-crypto/db';
import { Pool } from 'pg';

import { runPriceFill } from '../src/fill.js';
import { buildPriceProviderBundle } from '../src/providers/provider-factory.js';
import { recordingTransport, realFetchJson, throttled } from '../src/providers/transport.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'fixtures', 'providers', 'prices',
);

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new Error('DATABASE_URL is not set (put it in the root .env)');

  const pool = new Pool({ connectionString: url });
  const db = createDb(pool);
  const logger = createLogger({ name: 'capture-prices' });
  try {
    const transport = recordingTransport(throttled(realFetchJson(), 500), FIXTURES_DIR);
    const bundle = buildPriceProviderBundle({ env: process.env, fetchJson: transport });
    const result = await runPriceFill({ db, bundle, logger });
    logger.info('capture complete', { ...result, dir: FIXTURES_DIR });
  } finally {
    await pool.end();
  }
}

await main();

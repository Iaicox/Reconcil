/**
 * Unit coverage for the write-tool transaction helper's retry policy (write-tx.ts).
 * The DB-touching atomicity guarantee lives in write-tx.itest.ts; this file pins the
 * pure retry loop (serialization-failure handling) without a container.
 */
import { describe, expect, it } from 'vitest';

import { withRetry } from '../src/write-tx.js';

const pgErr = (code: string): { code: string } => ({ code });

describe('withRetry — serialization-failure policy', () => {
  it('retries a 40001 (serialization_failure) and returns the eventual success', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 2) throw pgErr('40001');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('retries a 40P01 (deadlock_detected) too', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 2) throw pgErr('40P01');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('gives up after the attempt cap and rethrows the last serialization error', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts += 1;
        throw pgErr('40001');
      }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(attempts).toBe(3); // MAX_TX_ATTEMPTS
  });

  it('does not retry a non-serialization error (e.g. a unique violation)', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts += 1;
        throw pgErr('23505');
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(attempts).toBe(1);
  });

  it('unwraps a driver error nested under `cause`', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 2) throw { cause: pgErr('40001') };
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
});

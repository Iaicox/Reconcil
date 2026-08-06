/**
 * Unit coverage for the write-tool transaction helper's retry policy (write-tx.ts).
 * The DB-touching atomicity guarantee lives in write-tx.itest.ts; this file pins the
 * pure retry loop (serialization-failure handling) without a container.
 */
import { describe, expect, it } from 'vitest';

import { withRetry } from '../src/write-tx.js';

// pg's DatabaseError is a real Error subclass with a `.code` — match that shape
// (Object.assign onto a real Error) rather than throwing a bare object literal.
const pgErr = (code: string): Error & { code: string } => Object.assign(new Error(`pg error ${code}`), { code });

describe('withRetry — serialization-failure policy', () => {
  it('retries a 40001 (serialization_failure) and returns the eventual success', async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts += 1;
      if (attempts < 2) throw pgErr('40001');
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('retries a 40P01 (deadlock_detected) too', async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts += 1;
      if (attempts < 2) throw pgErr('40P01');
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('gives up after the attempt cap and rethrows the last serialization error', async () => {
    let attempts = 0;
    await expect(
      withRetry(() => {
        attempts += 1;
        throw pgErr('40001');
      }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(attempts).toBe(3); // MAX_TX_ATTEMPTS
  });

  it('does not retry a non-serialization error (e.g. a unique violation)', async () => {
    let attempts = 0;
    await expect(
      withRetry(() => {
        attempts += 1;
        throw pgErr('23505');
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(attempts).toBe(1);
  });

  it('unwraps a driver error nested under `cause`', async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts += 1;
      if (attempts < 2) throw new Error('wrapped', { cause: pgErr('40001') });
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';

import { throttled } from '../src/providers/transport.js';

describe('throttled — spaces calls by ≥ the interval', () => {
  it('delays each subsequent call until the interval elapses', async () => {
    const times: number[] = [];
    const inner = (): Promise<{ status: number; body: unknown }> => {
      times.push(Date.now());
      return Promise.resolve({ status: 200, body: null });
    };
    const t = throttled(inner, 50);
    await t('a');
    await t('b');
    await t('c');
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(45);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(45);
  });

  it('serializes concurrent callers instead of letting them all fire together', async () => {
    // Regression for the concurrency bug: `wait` used to be computed synchronously
    // from a shared `last`, so N calls dispatched in the same tick all read the same
    // `last`, slept the same amount, then fired simultaneously — the throttle was
    // bypassed exactly when a burst needed it. Dispatch N calls WITHOUT awaiting
    // between them and assert real spacing still happened.
    const times: number[] = [];
    const inner = (): Promise<{ status: number; body: unknown }> => {
      times.push(Date.now());
      return Promise.resolve({ status: 200, body: null });
    };
    const ms = 40;
    const n = 5;
    const t = throttled(inner, ms);
    await Promise.all(Array.from({ length: n }, (_, i) => t(String(i))));
    expect(times).toHaveLength(n);
    const span = times[n - 1]! - times[0]!;
    expect(span).toBeGreaterThanOrEqual((n - 1) * ms - 5); // small slack for timer jitter
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(ms - 5);
    }
  });
});

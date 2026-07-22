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
});

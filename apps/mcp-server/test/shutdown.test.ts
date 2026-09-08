import type { Logger } from '@reconcil/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installShutdown } from '../src/shutdown.js';

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    logger: { info: () => {}, warn: () => {}, error: (msg: string) => errors.push(msg) },
  };
}

afterEach(() => {
  // installShutdown registers real process handlers; drop them so suites stay independent.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

describe('installShutdown', () => {
  it('closes, then exits 0', async () => {
    const codes: number[] = [];
    const order: string[] = [];
    const { logger } = recordingLogger();
    const shutdown = installShutdown({
      logger,
      close: () => { order.push('closed'); return Promise.resolve(); },
      exit: (c) => codes.push(c),
    });

    await shutdown('SIGTERM');
    expect(order).toEqual(['closed']);
    expect(codes).toEqual([0]);
  });

  it('exits 1 when the close throws — a failed shutdown must not report success', async () => {
    // The defect this replaces: http.ts ran `.catch(() => {}).finally(() => exit(0))`, so a
    // teardown that threw still told the orchestrator everything went cleanly.
    const codes: number[] = [];
    const { logger, errors } = recordingLogger();
    const shutdown = installShutdown({
      logger,
      close: () => Promise.reject(new Error('pool still busy')),
      exit: (c) => codes.push(c),
    });

    await shutdown('SIGTERM');
    expect(codes).toEqual([1]);
    expect(errors).toContain('shutdown error');
  });

  it('ignores a second signal while the first is still draining', async () => {
    // `process.once` per signal was not enough: SIGINT followed by SIGTERM is two
    // different events, and each would have started its own teardown.
    let closes = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { logger } = recordingLogger();
    const shutdown = installShutdown({
      logger,
      close: async () => { closes += 1; await gate; },
      exit: () => {},
    });

    const first = shutdown('SIGINT');
    await shutdown('SIGTERM'); // arrives mid-drain
    release();
    await first;

    expect(closes).toBe(1);
  });

  it('forces exit 1 when the close hangs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      const codes: number[] = [];
      const { logger, errors } = recordingLogger();
      const shutdown = installShutdown({
        logger,
        close: () => new Promise<void>(() => { /* never settles */ }),
        exit: (c) => codes.push(c),
        timeoutMs: 10_000,
      });

      void shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(10_000);

      expect(codes).toEqual([1]);
      expect(errors).toContain('shutdown timed out; forcing exit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers for both signals', () => {
    const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    installShutdown({ logger: recordingLogger().logger, close: () => Promise.resolve(), exit: () => {} });
    expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(before + 2);
  });
});

describe('installShutdown — the forced-exit timer', () => {
  it('is cleared once the close settles, so a clean shutdown reports no timeout', async () => {
    vi.useFakeTimers();
    try {
      const codes: number[] = [];
      const { logger, errors } = recordingLogger();
      const shutdown = installShutdown({
        logger,
        close: () => Promise.resolve(),
        exit: (c) => codes.push(c),
        timeoutMs: 10_000,
      });

      await shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(20_000);

      // Without clearTimeout this is [0, 1] plus a spurious timeout line.
      expect(codes).toEqual([0]);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

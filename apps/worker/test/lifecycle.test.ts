import type { Logger } from '@reconcil/core';
import { describe, expect, it, vi } from 'vitest';

import { registerShutdownHandlers, type MinimalProcess } from '../src/lifecycle.js';

function fakeProcess(): { proc: MinimalProcess; handlers: Map<string, ((...args: unknown[]) => void)[]> } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const proc: MinimalProcess = {
    on: (event, listener) => {
      const list = handlers.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      handlers.set(event, list);
      return proc;
    },
  };
  return { proc, handlers };
}

describe('registerShutdownHandlers', () => {
  it('registers SIGINT, SIGTERM, and unhandledRejection', () => {
    const { proc, handlers } = fakeProcess();
    registerShutdownHandlers({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, vi.fn(), proc);

    expect(handlers.has('SIGINT')).toBe(true);
    expect(handlers.has('SIGTERM')).toBe(true);
    expect(handlers.has('unhandledRejection')).toBe(true);
  });

  it('an unhandled rejection logs via serializeError and triggers shutdown', () => {
    const { proc, handlers } = fakeProcess();
    const errorLog = vi.fn();
    const logger: Logger = { error: errorLog, info: vi.fn(), warn: vi.fn() };
    const shutdown = vi.fn();

    registerShutdownHandlers(logger, shutdown, proc);
    const [handler] = handlers.get('unhandledRejection') ?? [];
    handler?.(new Error('boom'));

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toBe('unhandled rejection');
    expect(errorLog.mock.calls[0]?.[1]).toMatchObject({ err: { name: 'Error', message: 'boom' } });
    expect(shutdown).toHaveBeenCalledWith('unhandledRejection');
  });

  it('a signal triggers shutdown with the signal name', () => {
    const { proc, handlers } = fakeProcess();
    const shutdown = vi.fn();
    registerShutdownHandlers({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }, shutdown, proc);

    const [handler] = handlers.get('SIGTERM') ?? [];
    handler?.();

    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
  });
});

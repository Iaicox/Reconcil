/**
 * Signal + unhandled-rejection wiring, split out of main.ts for testability.
 * SIGINT/SIGTERM already ran the graceful shutdown; an unhandled rejection
 * outside the BullMQ error channels (q.on('error')/w.on('error')/w.on('failed'),
 * plus the pg Pool/Redis connection 'error' listeners) had no listener at all,
 * so Node's default behavior is to crash straight past those shutdown handlers
 * and print the raw error (possibly a hostile provider cause, ADR-011) to
 * stderr. An unhandled rejection means the process is in unknown state, so
 * this logs it via serializeError AND runs the same shutdown path a signal
 * would — not just a log line.
 */
import { serializeError, type Logger } from '@reconcil/core';

/** The slice of `process` this needs — one .on(event, listener), injectable for tests. */
export interface MinimalProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export function registerShutdownHandlers(
  logger: Logger,
  shutdown: (signal: string) => void | Promise<void>,
  proc: MinimalProcess = process,
): void {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    proc.on(signal, () => { void shutdown(signal); });
  }
  proc.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { err: serializeError(reason) });
    void shutdown('unhandledRejection');
  });
}

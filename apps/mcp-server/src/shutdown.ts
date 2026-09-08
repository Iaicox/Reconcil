/**
 * Signal-driven graceful shutdown, shared by both server entrypoints.
 *
 * `stdio.ts` grew this shape first (itself mirroring `apps/worker/src/main.ts`) and
 * `http.ts` never did: it registered `process.once` per signal with no idempotency across
 * signals, no forced-exit timer, and a `.finally(() => process.exit(0))` that reported
 * SUCCESS even when the close had thrown. An orchestrator reading that exit code would be
 * told a shutdown went cleanly when it had not. One implementation removes the question of
 * which entrypoint is the correct one.
 *
 * The ordering is the part that matters: whatever holds requests closes BEFORE the pg
 * pool, so no in-flight tool call is severed mid-transaction. Callers express that by the
 * order of the awaits inside `close`.
 */
import { serializeError, type Logger } from '@reconcil/core';

/** Worker's shutdown timeout (apps/worker/src/main.ts) — same grace period. */
export const FORCE_EXIT_TIMEOUT_MS = 10_000;

export interface ShutdownOptions {
  logger: Logger;
  /** Ordered teardown. Close the server/transport first, the pg pool last. */
  close: () => Promise<void>;
  /** Injected by tests; defaults to `process.exit`, which is why this seam exists at all. */
  exit?: (code: number) => void;
  timeoutMs?: number;
}

/**
 * Register SIGINT/SIGTERM handlers and return the handler itself, so a test can drive it
 * without raising real signals. Idempotent across signals — a second SIGTERM arriving
 * while the first is still draining is ignored, not a second concurrent teardown.
 */
export function installShutdown(opts: ShutdownOptions): (signal: string) => Promise<void> {
  const { logger, close } = opts;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? FORCE_EXIT_TIMEOUT_MS;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // unref'd: the timer must not be the reason the process stays alive if the close
    // finishes first.
    const force = setTimeout(() => { logger.error('shutdown timed out; forcing exit'); exit(1); }, timeoutMs);
    force.unref();
    try {
      await close();
      exit(0);
    } catch (err) {
      logger.error('shutdown error', { err: serializeError(err) });
      exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void shutdown(signal); });
  }
  return shutdown;
}

import type { Logger } from '@pet-crypto/core';

/**
 * A structured JSON Logger that writes to STDERR. stdio.ts and keygen.ts need it
 * because core.createLogger writes to stdout — which stdio reserves for the
 * JSON-RPC protocol stream and keygen reserves for the one-time plaintext key.
 * Same line shape as core.createLogger, redirected so stdout stays clean.
 */
export function createStderrLogger(name: string): Logger {
  const emit = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, name, msg, ...fields })}\n`);
  };
  return {
    info: (msg, fields) => { emit('info', msg, fields); },
    warn: (msg, fields) => { emit('warn', msg, fields); },
    error: (msg, fields) => { emit('error', msg, fields); },
  };
}

/**
 * Structured JSON logger + hostile-safe error serialization (ADR-011). err.cause
 * and raw provider/token strings are hostile: serializeError emits only
 * { name, message, kind? } — never cause, never stack, never raw strings. The
 * message field is adapter/worker-controlled (safe by construction); provider
 * text lives in cause, which we drop.
 */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function serializeError(err: unknown): { name: string; message: string; kind?: string } {
  if (err instanceof Error) {
    const kind = (err as { kind?: unknown }).kind;
    return typeof kind === 'string'
      ? { name: err.name, message: err.message, kind }
      : { name: err.name, message: err.message };
  }
  return { name: 'NonError', message: 'non-error thrown' };
}

export function createLogger(opts?: { name?: string }): Logger {
  const name = opts?.name ?? 'app';
  const emit = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, name, msg, ...fields }));
  };
  return {
    info: (msg, fields) => { emit('info', msg, fields); },
    warn: (msg, fields) => { emit('warn', msg, fields); },
    error: (msg, fields) => { emit('error', msg, fields); },
  };
}

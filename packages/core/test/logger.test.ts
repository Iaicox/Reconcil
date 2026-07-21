import { describe, expect, it, vi } from 'vitest';
import { createLogger, serializeError } from '../src/logger.js';

describe('serializeError', () => {
  it('never leaks err.cause (hostile provider text)', () => {
    const err = new Error('missing receipt', { cause: 'HOSTILE <script> token name' });
    const out = serializeError(err);
    expect(out).toEqual({ name: 'Error', message: 'missing receipt' });
    expect(JSON.stringify(out)).not.toContain('HOSTILE');
  });

  it('carries a ProviderError-style kind when present', () => {
    class ProviderError extends Error {
      kind = 'rate_limited';
      constructor(m: string) { super(m); this.name = 'ProviderError'; }
    }
    expect(serializeError(new ProviderError('slow down'))).toEqual({
      name: 'ProviderError', message: 'slow down', kind: 'rate_limited',
    });
  });

  it('handles non-Error throwables without leaking their content', () => {
    expect(serializeError({ secret: 'x' })).toEqual({ name: 'NonError', message: 'non-error thrown' });
  });
});

describe('createLogger', () => {
  it('emits one JSON line per call with level, name, msg, fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger({ name: 'worker' }).info('tick', { chainId: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: 'info', name: 'worker', msg: 'tick', chainId: 1 });
    expect(typeof line.time).toBe('string');
    spy.mockRestore();
  });
});

import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, type EventCursor } from '../src/cursor.js';

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');

describe('cursor', () => {
  it('round-trips a keyset position', () => {
    const c: EventCursor = { chainId: 8453, blockNumber: 12_345_678, logIndex: -1, id: 42 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('produces a url-safe token (no +, /, =)', () => {
    const c: EventCursor = { chainId: 1, blockNumber: 1, logIndex: 0, id: 1 };
    expect(encodeCursor(c)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects malformed or tampered cursors', () => {
    expect(() => decodeCursor('')).toThrow(RangeError);
    expect(() => decodeCursor(b64({ chainId: 1 }))).toThrow(RangeError); // object, not the tuple
    expect(() => decodeCursor(b64([1, 2, 3]))).toThrow(RangeError); // wrong arity
    expect(() => decodeCursor(b64([1, 2, 3, 'x']))).toThrow(RangeError); // non-integer field
    expect(() => decodeCursor(Buffer.from('not json', 'utf8').toString('base64url'))).toThrow(RangeError);
  });
});

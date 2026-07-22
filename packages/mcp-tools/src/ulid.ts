/**
 * Minimal ULID (Crockford base32): 48-bit millisecond timestamp + 80 bits of
 * randomness, lexically sortable by time — the `tool_calls.id` format (C2). No
 * dependency; the DB index orders by `called_at`, so strict monotonicity within a
 * millisecond isn't required.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I,L,O,U)

export function ulid(now: number = Date.now()): string {
  let time = now;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = ENCODING[time % 32]!;
    time = Math.floor(time / 32);
  }

  // 10 random bytes (80 bits) → 16 base32 chars, 5 bits at a time.
  const rand = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of rand) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENCODING[(value >>> bits) & 31];
    }
  }
  return timeChars.join('') + out;
}

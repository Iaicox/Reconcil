/**
 * Opaque keyset cursor for `list_events` pagination. Encodes position only
 * (chain_id, block_number, log_index, id) — never filters — so the caller must
 * resend identical filters across pages. Stable by construction: `chain_events`
 * is append-only, ids never change (ADR-005). Compact JSON tuple, base64url.
 */
import { Buffer } from 'node:buffer';

export interface EventCursor {
  chainId: number;
  blockNumber: number;
  logIndex: number;
  id: number;
}

export function encodeCursor(c: EventCursor): string {
  return Buffer.from(JSON.stringify([c.chainId, c.blockNumber, c.logIndex, c.id]), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): EventCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw new RangeError(`invalid cursor: ${s}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    !parsed.every((n) => typeof n === 'number' && Number.isInteger(n))
  ) {
    throw new RangeError(`invalid cursor: ${s}`);
  }
  const [chainId, blockNumber, logIndex, id] = parsed as [number, number, number, number];
  return { chainId, blockNumber, logIndex, id };
}

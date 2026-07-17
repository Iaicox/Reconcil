import { z } from 'zod';
import { ProviderError } from '../types.js';

const accountEnvelope = z.object({
  status: z.string(),
  message: z.string(),
  result: z.unknown(),
});

/**
 * Etherscan-style {status, message, result} envelope, shared by both providers.
 * Quirks live here and never leak past adapters (ADR-009).
 */
export function unwrapAccountEnvelope(status: number, body: unknown): unknown {
  throwOnHttpError(status);
  const parsed = accountEnvelope.safeParse(body);
  if (!parsed.success) throw new ProviderError('malformed', 'unexpected envelope shape');
  const { status: s, message, result } = parsed.data;
  if (s === '0') {
    // "No transactions found" / "No token transfers found" ⇒ empty page, not an error
    if (/^no .+ found$/i.test(message)) return [];
    const text = typeof result === 'string' ? result : message;
    if (/rate limit/i.test(text)) {
      throw new ProviderError('rate_limited', 'provider rate limit', { cause: text });
    }
    throw new ProviderError('provider_error', 'provider returned an error status', { cause: text });
  }
  return result;
}

/** JSON-RPC style {result} envelope used by the proxy module. */
export function unwrapProxy<T>(status: number, body: unknown, schema: z.ZodType<T>): T {
  throwOnHttpError(status);
  // Etherscan V2 reports proxy-module errors in the ACCOUNT envelope shape
  // ({status:"0", message, result}) — e.g. "free tier does not cover this
  // chain". Route those through the same error taxonomy instead of letting an
  // error string parse as a legitimate result.
  const envelope = accountEnvelope.safeParse(body);
  if (envelope.success && envelope.data.status === '0') {
    const { message, result } = envelope.data;
    const text = typeof result === 'string' ? result : message;
    if (/rate limit/i.test(text)) {
      throw new ProviderError('rate_limited', 'provider rate limit', { cause: text });
    }
    throw new ProviderError('provider_error', 'provider returned an error status', { cause: text });
  }
  const parsed = z.object({ result: schema }).safeParse(body);
  if (!parsed.success) throw new ProviderError('malformed', 'unexpected proxy response shape');
  return parsed.data.result;
}

/** Proxy hex quantity (eth_blockNumber) → bigint, guarded so error text never reaches BigInt(). */
export function unwrapProxyHex(status: number, body: unknown): bigint {
  const hex = unwrapProxy(status, body, z.string());
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new ProviderError('malformed', 'proxy returned a non-numeric quantity', { cause: hex });
  }
  return BigInt(hex);
}

/**
 * Zod parse → ProviderError('malformed'). Deliberately does NOT embed the Zod
 * error or response content: provider strings are hostile (ADR-011).
 */
export function parseRows<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderError('malformed', 'response rows failed validation');
  return parsed.data;
}

function throwOnHttpError(status: number): void {
  if (status === 429) throw new ProviderError('rate_limited', 'HTTP 429');
  if (status >= 400) throw new ProviderError('http', `HTTP ${String(status)}`);
}

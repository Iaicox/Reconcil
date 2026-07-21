/**
 * Public JSON-RPC receipt path (03-ingestion §6): Base receipts come from a
 * public node, not the indexer APIs. Raw JSON-RPC over fetch — NO signing/RPC
 * library (P8). POST-only, so it does not use the GET-shaped FetchJson seam.
 */
import { ProviderError, type RawReceipt } from '../types.js';
import { mapReceipt, receiptResult } from './etherscan-v2.js';
import { parseRows } from './envelope.js';

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

// Cap each RPC round-trip so a wedged upstream connection can't pin a worker
// slot forever (BullMQ retries failed calls, not hung ones).
const RPC_TIMEOUT_MS = 30_000;

export function httpRpcCall(url: string): RpcCall {
  return async (method, params) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout (AbortSignal) or a transport failure — surface as ProviderError
      // so retry/backoff handles it. `cause` (never logged) keeps the detail.
      throw new ProviderError('http', 'rpc request failed or timed out', { cause: err });
    }
    if (res.status === 429) throw new ProviderError('rate_limited', 'HTTP 429');
    if (!res.ok) throw new ProviderError('http', `HTTP ${String(res.status)}`);
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    // Never embed json.error — RPC error text is hostile (ADR-011).
    if (json.error !== undefined) throw new ProviderError('provider_error', 'rpc returned an error');
    return json.result;
  };
}

export async function rpcGetReceipts(rpc: RpcCall, hashes: string[]): Promise<RawReceipt[]> {
  const out: RawReceipt[] = [];
  for (const hash of hashes) {
    const result = await rpc('eth_getTransactionReceipt', [hash]);
    // A node returns null for an unknown/dropped/pending tx. Queries stay
    // ≤ safeHead so this should not occur — surface a clear error (hash in the
    // never-logged cause, ADR-011) rather than a generic Zod parse failure.
    if (result === null) {
      throw new ProviderError('provider_error', 'no receipt (dropped/pending tx or queried past safeHead)', { cause: hash });
    }
    out.push(mapReceipt(parseRows(receiptResult, result)));
  }
  return out;
}

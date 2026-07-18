/**
 * Public JSON-RPC receipt path (03-ingestion §6): Base receipts come from a
 * public node, not the indexer APIs. Raw JSON-RPC over fetch — NO signing/RPC
 * library (P8). POST-only, so it does not use the GET-shaped FetchJson seam.
 */
import { ProviderError, type RawReceipt } from '../types.js';
import { mapReceipt, receiptResult } from './etherscan-v2.js';
import { parseRows } from './envelope.js';

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export function httpRpcCall(url: string): RpcCall {
  return async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
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
    out.push(mapReceipt(parseRows(receiptResult, result)));
  }
  return out;
}

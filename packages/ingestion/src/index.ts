/**
 * Ingestion: providers → normalized events; checkpoints; finality; backfill /
 * live; integrity checks (03-ingestion.md, ADR-005/008/009). Worker-only —
 * never imported by the MCP server path.
 */
export * from './types.js';
export { canonicalizeUrl, fixtureFileName, fixtureTransport, realFetchJson, recordingTransport } from './fixture-transport.js';
export { normalize, ZERO_ADDRESS, type NormalizeContext } from './normalize.js';
export { collectAllPages } from './paging.js';
export { etherscanV2Adapter } from './providers/etherscan-v2.js';
export { blockscoutAdapter } from './providers/blockscout.js';
export { readManifest, upsertManifest, assertScrubbed, type WalletManifestEntry } from './manifest.js';
export { buildProviderBundle, failoverProvider, type ProviderBundle, type BalanceResult } from './providers/provider-factory.js';
export { httpRpcCall, rpcGetReceipts, type RpcCall } from './providers/rpc.js';
export { assignErc20Metadata, type Erc20WithMeta } from './logindex.js';
export { runBackfillPage, type BackfillTarget, type ProcessorDeps } from './processors/backfill.js';
export { runTailTick } from './processors/tail.js';
export { runAnchor, type AnchorResult } from './processors/anchor.js';
export { runProbe, type ProbeTarget } from './processors/probe.js';
export { type IngestResult, type IngestTarget } from './processors/ingest.js';
export {
  getCheckpoint, seedCheckpoint, listQueuedCheckpoints, listAnchoringCheckpoints, listProbeTargets,
  commitPage, commitAnchor, setTxCountHint, type AnchorTarget,
} from './write/checkpoint-repo.js';
export { insertEventRows, toChainEventRow } from './write/event-writer.js';
export { buildOpeningBalanceRows, anchorTxHash, type OpeningBalance } from './write/anchor-writer.js';
export { tokenInsertValues } from './write/token-repo.js';

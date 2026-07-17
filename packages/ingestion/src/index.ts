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

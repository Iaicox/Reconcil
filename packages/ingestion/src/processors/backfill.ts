import { ingestOnce, type IngestResult, type IngestTarget, type ProcessorDeps } from './ingest.js';

// Re-export so consumers (index.ts, the worker) get ProcessorDeps from either module.
export type { ProcessorDeps, IngestResult } from './ingest.js';
export type BackfillTarget = IngestTarget;

/** One backfill page. The BullMQ host re-enqueues while status === 'backfilling'. */
export function runBackfillPage(deps: ProcessorDeps, target: BackfillTarget): Promise<IngestResult> {
  return ingestOnce(deps, target);
}

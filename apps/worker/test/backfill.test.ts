import type { IngestResult } from '@reconcil/ingestion';
import { describe, expect, it } from 'vitest';

import { dlqJobOptions } from '../src/queues.js';
import { runBackfillJob, type BackfillJobDeps, type BackfillPageAdd } from '../src/backfill.js';

const target = { chainId: 1, address: '0xabc', stream: 'native' as const };

describe('runBackfillJob (H15b stall guard)', () => {
  it('re-enqueues the next page once when the checkpoint advances', async () => {
    const added: { data: unknown; opts: unknown }[] = [];
    const queue: BackfillPageAdd = {
      add: (name, data, opts) => { added.push({ data, opts }); return Promise.resolve(undefined); },
    };
    const res: IngestResult = { status: 'backfilling', lastProcessedBlock: 200, inserted: 3, unseenContracts: [] };
    const deps: BackfillJobDeps = {
      runPage: () => Promise.resolve(res),
      getCheckpointBlock: () => Promise.resolve(100),
    };

    const out = await runBackfillJob(deps, target, queue);

    expect(out).toBe(res);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ data: target, opts: dlqJobOptions });
  });

  it('does not re-enqueue when the result is live (page fully drained)', async () => {
    const added: unknown[] = [];
    const queue: BackfillPageAdd = { add: (...args) => { added.push(args); return Promise.resolve(undefined); } };
    const res: IngestResult = { status: 'live', lastProcessedBlock: 500, inserted: 1, unseenContracts: [] };
    const deps: BackfillJobDeps = {
      runPage: () => Promise.resolve(res),
      getCheckpointBlock: () => Promise.resolve(100),
    };

    await runBackfillJob(deps, target, queue);

    expect(added).toHaveLength(0);
  });

  it('throws instead of re-enqueueing when the checkpoint did not advance while backfilling', async () => {
    const added: unknown[] = [];
    const queue: BackfillPageAdd = { add: (...args) => { added.push(args); return Promise.resolve(undefined); } };
    const res: IngestResult = { status: 'backfilling', lastProcessedBlock: 100, inserted: 0, unseenContracts: [] };
    const deps: BackfillJobDeps = {
      runPage: () => Promise.resolve(res),
      getCheckpointBlock: () => Promise.resolve(100), // same as res.lastProcessedBlock — no progress
    };

    await expect(runBackfillJob(deps, target, queue)).rejects.toThrow(/stalled/);
    expect(added).toHaveLength(0);
  });

  it('throws when the checkpoint regressed while backfilling', async () => {
    const added: unknown[] = [];
    const queue: BackfillPageAdd = { add: (...args) => { added.push(args); return Promise.resolve(undefined); } };
    const res: IngestResult = { status: 'backfilling', lastProcessedBlock: 90, inserted: 0, unseenContracts: [] };
    const deps: BackfillJobDeps = {
      runPage: () => Promise.resolve(res),
      getCheckpointBlock: () => Promise.resolve(100),
    };

    await expect(runBackfillJob(deps, target, queue)).rejects.toThrow(/stalled/);
    expect(added).toHaveLength(0);
  });

  it('error message carries only numbers, no address/provider text', async () => {
    const queue: BackfillPageAdd = { add: () => Promise.resolve(undefined) };
    const res: IngestResult = { status: 'backfilling', lastProcessedBlock: 100, inserted: 0, unseenContracts: [] };
    const deps: BackfillJobDeps = { runPage: () => Promise.resolve(res), getCheckpointBlock: () => Promise.resolve(100) };

    let message = '';
    try {
      await runBackfillJob(deps, target, queue);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(target.address);
    expect(message).toMatch(/\d/); // carries the block number(s)
  });
});

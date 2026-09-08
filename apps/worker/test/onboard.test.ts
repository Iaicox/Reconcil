import type { JobsOptions } from 'bullmq';
import { describe, expect, it } from 'vitest';

import {
  enqueueAnchors, enqueueBackfills, enqueueProbes,
  type AnchorEnqueuer, type BackfillEnqueuer, type ProbeEnqueuer,
} from '../src/onboard.js';

describe('enqueueBackfills', () => {
  it('enqueues one page per target with the shared deterministic job id', async () => {
    const calls: { name: string; data: unknown; opts: JobsOptions }[] = [];
    const queue: BackfillEnqueuer = {
      add: (name, data, opts) => { calls.push({ name, data, opts }); return Promise.resolve(undefined); },
      getJob: () => Promise.resolve(undefined),
    };

    await enqueueBackfills(
      [{ chainId: 1, address: '0xabc', stream: 'native' }, { chainId: 8453, address: '0xdef', stream: 'erc20' }],
      queue,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      name: 'page',
      data: { chainId: 1, address: '0xabc', stream: 'native' },
      opts: { jobId: 'backfill:1:0xabc:native' },
    });
    expect(calls[1]!.opts.jobId).toBe('backfill:8453:0xdef:erc20');
    // the shared retry policy is merged in (ADR-008 §2)
    expect(calls[0]!.opts.attempts).toBe(8);
  });

  it('does nothing for an empty target set', async () => {
    let added = 0;
    const queue: BackfillEnqueuer = { add: () => { added += 1; return Promise.resolve(undefined); }, getJob: () => Promise.resolve(undefined) };
    await enqueueBackfills([], queue);
    expect(added).toBe(0);
  });
});

describe('enqueueAnchors', () => {
  it('enqueues one anchor job per target with the deterministic anchor job id', async () => {
    const calls: { name: string; data: unknown; opts: JobsOptions }[] = [];
    const queue: AnchorEnqueuer = {
      add: (name, data, opts) => { calls.push({ name, data, opts }); return Promise.resolve(undefined); },
      getJob: () => Promise.resolve(undefined),
    };

    await enqueueAnchors(
      [{ chainId: 1, address: '0xabc', stream: 'native', anchorFrom: '2024-01-01' }],
      queue,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'anchor',
      data: { chainId: 1, address: '0xabc', stream: 'native', anchorFrom: '2024-01-01' },
      opts: { jobId: 'anchor:1:0xabc:native', attempts: 8 },
    });
  });
});

describe('enqueueProbes', () => {
  it('enqueues one probe job per wallet with the per-address job id', async () => {
    const calls: { name: string; data: unknown; opts: JobsOptions }[] = [];
    const queue: ProbeEnqueuer = {
      add: (name, data, opts) => { calls.push({ name, data, opts }); return Promise.resolve(undefined); },
      getJob: () => Promise.resolve(undefined),
    };

    await enqueueProbes([{ chainId: 1, address: '0xABC' }], queue);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'probe',
      data: { chainId: 1, address: '0xABC' },
      opts: { jobId: 'probe:1:0xabc' },
    });
  });
});

// --- retained-job wedge (the fresh-chain `queued` path) --------------------------------

/** A fake queue whose `getJob` returns a job in the given terminal/live state. */
function queueHolding(state: 'completed' | 'failed' | 'waiting' | 'none') {
  const added: string[] = [];
  let removed = false;
  const job = {
    isCompleted: () => Promise.resolve(state === 'completed'),
    isFailed: () => Promise.resolve(state === 'failed'),
    remove: () => { removed = true; return Promise.resolve(undefined); },
  };
  const queue: BackfillEnqueuer = {
    add: (_n, _d, opts) => { added.push(String(opts.jobId)); return Promise.resolve(undefined); },
    getJob: () => Promise.resolve(state === 'none' ? undefined : job),
  };
  return { queue, added, wasRemoved: () => removed };
}

const TARGET = { chainId: 1, address: '0xabc', stream: 'native' } as const;

describe('enqueueBackfills — a completed job must not silently swallow the re-add', () => {
  it('clears a COMPLETED job holding the id, then re-adds', async () => {
    // ingestOnce's H7 branch completes the job without advancing the checkpoint (fresh
    // chain: head < finalityDepth). removeOnComplete:1000 then keeps that job around, and
    // on a quiet deployment the checkpoint sits at `queued` for as long as it takes 1000
    // other jobs to complete.
    const { queue, added, wasRemoved } = queueHolding('completed');
    await enqueueBackfills([TARGET], queue);
    expect(wasRemoved()).toBe(true);
    expect(added).toEqual(['backfill:1:0xabc:native']);
  });

  it('LEAVES a failed job alone — it is the ADR-008 dead-letter record', async () => {
    // Removing it would delete the only evidence the backfill exhausted its 8 attempts,
    // and the ~15s onboard tick would then re-add the job forever against a provider that
    // already rejected it. The fix for that wedge is flipping the checkpoint to `error`.
    const { queue, added, wasRemoved } = queueHolding('failed');
    await enqueueBackfills([TARGET], queue);
    expect(wasRemoved()).toBe(false);
    expect(added).toEqual(['backfill:1:0xabc:native']);
  });

  it('leaves a job that is still waiting or active alone — that dedup is the point', async () => {
    const { queue, added, wasRemoved } = queueHolding('waiting');
    await enqueueBackfills([TARGET], queue);
    expect(wasRemoved()).toBe(false);
    // The add still runs; BullMQ dedups it against the live job, which is correct.
    expect(added).toEqual(['backfill:1:0xabc:native']);
  });

  it('adds normally when nothing holds the id', async () => {
    const { queue, added, wasRemoved } = queueHolding('none');
    await enqueueBackfills([TARGET], queue);
    expect(wasRemoved()).toBe(false);
    expect(added).toEqual(['backfill:1:0xabc:native']);
  });

  it('a lookup failure does not abort the scan for the remaining targets', async () => {
    // The job can vanish between lookup and remove (its retention aged out, or another
    // scanner got there first) — which is the state we wanted anyway.
    const added: string[] = [];
    const queue: BackfillEnqueuer = {
      add: (_n, _d, opts) => { added.push(String(opts.jobId)); return Promise.resolve(undefined); },
      getJob: () => Promise.reject(new Error('redis blip')),
    };
    await enqueueBackfills([TARGET, { chainId: 8453, address: '0xdef', stream: 'erc20' }], queue);
    expect(added).toEqual(['backfill:1:0xabc:native', 'backfill:8453:0xdef:erc20']);
  });
});

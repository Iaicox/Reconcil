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
      add: async (name, data, opts) => { calls.push({ name, data, opts }); return undefined; },
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
    const queue: BackfillEnqueuer = { add: async () => { added += 1; return undefined; } };
    await enqueueBackfills([], queue);
    expect(added).toBe(0);
  });
});

describe('enqueueAnchors', () => {
  it('enqueues one anchor job per target with the deterministic anchor job id', async () => {
    const calls: { name: string; data: unknown; opts: JobsOptions }[] = [];
    const queue: AnchorEnqueuer = {
      add: async (name, data, opts) => { calls.push({ name, data, opts }); return undefined; },
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
      add: async (name, data, opts) => { calls.push({ name, data, opts }); return undefined; },
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

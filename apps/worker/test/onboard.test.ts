import type { JobsOptions } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { enqueueBackfills, type BackfillEnqueuer } from '../src/onboard.js';

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

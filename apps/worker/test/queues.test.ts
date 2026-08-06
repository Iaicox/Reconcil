import { describe, expect, it } from 'vitest';

import { dlqJobOptions, tickJobOptions } from '../src/queues.js';

// H15a: DLQ retention (removeOnFail: false) must stay scoped to one-shot jobs
// (backfill/anchor/probe); high-frequency ticks (tail/prices/onboard) need a
// bounded removeOnFail so a sustained outage can't grow Redis without limit.
describe('job option sets', () => {
  it('dlqJobOptions keeps every failed job (unbounded DLQ)', () => {
    expect(dlqJobOptions.removeOnFail).toBe(false);
    expect(dlqJobOptions.removeOnComplete).toBe(1000);
    expect(dlqJobOptions.attempts).toBe(8);
  });

  it('tickJobOptions bounds retained failures', () => {
    expect(tickJobOptions.removeOnFail).toEqual({ count: 100 });
    expect(tickJobOptions.removeOnComplete).toBe(1000);
    expect(tickJobOptions.attempts).toBe(8);
  });

  it('the two option sets are not the same object', () => {
    expect(dlqJobOptions).not.toBe(tickJobOptions);
  });
});

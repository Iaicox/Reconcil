/**
 * Hermetic coverage for status-repo.ts's pure record-count mapping (no DB — the four
 * aggregate SQL reads live in status-repo.itest.ts / recon-status.itest.ts).
 */
import { describe, expect, it } from 'vitest';

import { mapStatusCounts } from '../src/recon/status-repo.js';

describe('mapStatusCounts — C7 contract whitelist', () => {
  it('maps known statuses into the strict 5-key shape, defaulting absent ones to 0', () => {
    expect(mapStatusCounts([{ status: 'open', count: 2 }, { status: 'matched', count: 1 }])).toEqual({
      open: 2, partially_matched: 0, matched: 1, overpaid: 0, void: 0,
    });
  });

  it('skips a status outside the contract enum rather than injecting an extra key', () => {
    // The DB CHECK on external_records.status makes this unreachable today; the guard is
    // forward-compatible with a future migration widening the enum ahead of this mapping.
    // Injecting the raw key would fail reconStatusOutput's strict parse (INTERNAL, C7).
    expect(mapStatusCounts([{ status: 'archived', count: 5 }, { status: 'open', count: 1 }])).toEqual({
      open: 1, partially_matched: 0, matched: 0, overpaid: 0, void: 0,
    });
  });

  it('returns the all-zero map for no rows', () => {
    expect(mapStatusCounts([])).toEqual({ open: 0, partially_matched: 0, matched: 0, overpaid: 0, void: 0 });
  });
});

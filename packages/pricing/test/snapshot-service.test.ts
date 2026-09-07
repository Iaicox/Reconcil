import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Query-shape proxy for "materializePegSnapshots does not rescan already-covered
// history" (the DB-hitting itest proves the row-count behavior end to end; this proves
// the mechanism is actually the anti-join, not just ON CONFLICT DO NOTHING coincidentally
// producing the same counts in the itest's specific scenarios).
const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'snapshot-service.ts'),
  'utf8',
);

describe('materializePegSnapshots — query shape', () => {
  it('filters candidates with a NOT EXISTS anti-join against price_snapshots before the DISTINCT/insert', () => {
    const insertIdx = SOURCE.indexOf('INSERT INTO price_snapshots');
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    const query = SOURCE.slice(insertIdx);
    expect(query).toMatch(/NOT EXISTS/);
    // The anti-join must reference price_snapshots (not some unrelated table) and key on
    // the same tuple the unique constraint uses, so it actually recognizes prior runs.
    const antiJoinIdx = query.indexOf('NOT EXISTS');
    const antiJoin = query.slice(antiJoinIdx, antiJoinIdx + 300);
    expect(antiJoin).toMatch(/FROM price_snapshots ps/);
    expect(antiJoin).toMatch(/ps\.token_id/);
    expect(antiJoin).toMatch(/ps\.price_date/);
    expect(antiJoin).toMatch(/ps\.source\s*=\s*'peg'/);
  });

  it('is not keyed on block_time / a date watermark (unsafe for backfilled old events)', () => {
    const insertIdx = SOURCE.indexOf('INSERT INTO price_snapshots');
    const query = SOURCE.slice(insertIdx);
    expect(query).not.toMatch(/block_time\s*>=/);
    expect(query).not.toMatch(/max\(price_date\)/i);
  });
});

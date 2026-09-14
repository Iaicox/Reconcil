/**
 * The empty-id short-circuit in `hydratePriceRefs`/`hydrateFxRefs` (H11).
 *
 * Hermetic on purpose. The obvious itest — "an empty list returns an empty map" — proves
 * nothing: drizzle's `inArray(col, [])` also yields zero rows, so deleting the guard leaves
 * that assertion green while every stablecoin-face-value export goes back to paying for a
 * round trip it does not need. The behaviour under test is "no query is issued", and the
 * only way to observe that is a database that refuses to be touched.
 */
import { describe, expect, it } from 'vitest';

import { hydrateFxRefs, hydratePriceRefs } from '../src/pricing-refs.js';

import type { Db } from '@reconcil/db';

/** A `Db` whose every entry point throws — reaching the driver at all is the failure. */
const forbiddenDb = new Proxy({} as Db, {
  get(_t, prop) {
    throw new Error(`hydrate reached the database (.${String(prop)}) for an empty id list`);
  },
});

describe('ref hydration short-circuits an empty id list', () => {
  it('hydratePriceRefs issues no query', async () => {
    await expect(hydratePriceRefs(forbiddenDb, [])).resolves.toEqual(new Map());
  });

  it('hydrateFxRefs issues no query', async () => {
    await expect(hydrateFxRefs(forbiddenDb, [])).resolves.toEqual(new Map());
  });

  it('the stub really would fail a non-empty list — the tests above are not vacuous', async () => {
    await expect(hydratePriceRefs(forbiddenDb, [1])).rejects.toThrow(/reached the database/);
    await expect(hydrateFxRefs(forbiddenDb, [1])).rejects.toThrow(/reached the database/);
  });
});

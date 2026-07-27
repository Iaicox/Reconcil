import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/**
 * A transaction handle, as passed to a `db.transaction(async (tx) => …)` callback. It
 * exposes the same insert/select/update/delete query surface as `Db`, so repository code
 * can run against either — the seam the write-tool atomicity helper threads through
 * (domain write + tool_call audit in one transaction).
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Drizzle handle over an externally owned pg Pool (caller manages lifecycle). */
export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

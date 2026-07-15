import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/** Drizzle handle over an externally owned pg Pool (caller manages lifecycle). */
export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

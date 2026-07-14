/**
 * Tenant-scoped repositories over the Drizzle schema. Tenant identity comes
 * from the transport session, never from tool arguments (ADR-006).
 */
export * from './schema.js';
export { createDb, type Db } from './client.js';

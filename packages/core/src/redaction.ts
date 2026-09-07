/**
 * URL query-param names that carry provider API keys/secrets, shared by every fixture
 * transport (pricing's `providers/transport.ts`, ingestion's `fixture-transport.ts`).
 * Each domain package builds its own transport (pricing and ingestion are siblings and
 * may not import each other's internals — dependency-cruiser
 * `domain-depends-only-on-db-core`), but both may depend on this shared kernel, so the
 * redaction list itself lives here once instead of drifting between two copies.
 */
export const SECRET_QUERY_PARAMS = ['apikey', 'x_cg_demo_api_key', 'token'] as const;

/**
 * MCP server env (ADR-012 / docker-compose). DATABASE_URL is injected by compose;
 * the SELF_HOST_TENANT_* pair names the single self-host tenant the stdio entry
 * resolves on boot (P10). HTTP bearer keys live in `api_keys` and are minted with
 * the keygen script — no env for them.
 */
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8484),
  SELF_HOST_TENANT_SLUG: z.string().min(1).default('self-host'),
  SELF_HOST_TENANT_NAME: z.string().min(1).default('Self-hosted'),
});

export type ServerConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return schema.parse(env);
}

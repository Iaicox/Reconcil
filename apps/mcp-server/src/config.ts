/**
 * MCP server env (ADR-012 / docker-compose). DATABASE_URL is injected by compose;
 * the SELF_HOST_TENANT_* pair names the single self-host tenant the stdio entry
 * resolves on boot (P10). HTTP bearer keys live in `api_keys` and are minted with
 * the keygen script — no env for them.
 */
import { z } from 'zod';

/** docker-compose.yml maps this on the host; .env.example documents it. */
export const DEFAULT_PORT = 8484;

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  SELF_HOST_TENANT_SLUG: z.string().min(1).default('self-host'),
  SELF_HOST_TENANT_NAME: z.string().min(1).default('Self-hosted'),
  // Comma-split Host header allow-list for the streamable-HTTP transport's DNS-
  // rebinding protection (http.ts). Unset ⇒ resolveAllowedHosts derives the default
  // from PORT. See .env.example for the deployment-shaped default.
  RECONCIL_ALLOWED_HOSTS: z.string().optional(),
});

export type ServerConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return schema.parse(env);
}

/**
 * Host header allow-list for `StreamableHTTPServerTransport`'s
 * `enableDnsRebindingProtection` (the SDK matches the raw `Host` header value
 * exactly — no port normalization, see node_modules @modelcontextprotocol/sdk
 * webStandardStreamableHttp.js `validateRequestHeaders`). RECONCIL_ALLOWED_HOSTS
 * overrides with a comma-split list; unset ⇒ the three forms the deployment
 * reality actually sends: localhost / 127.0.0.1 (host-mapped local dev) and the
 * `mcp-server` compose service name, all suffixed with the configured PORT.
 */
export function resolveAllowedHosts(cfg: Pick<ServerConfig, 'PORT' | 'RECONCIL_ALLOWED_HOSTS'>): string[] {
  if (cfg.RECONCIL_ALLOWED_HOSTS !== undefined) {
    const hosts = cfg.RECONCIL_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
    if (hosts.length > 0) return hosts;
  }
  const port = String(cfg.PORT);
  return [`localhost:${port}`, `127.0.0.1:${port}`, `mcp-server:${port}`];
}

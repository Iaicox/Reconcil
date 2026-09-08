/**
 * MCP server env (ADR-012 / docker-compose). DATABASE_URL is injected by compose;
 * the SELF_HOST_TENANT_* pair names the single self-host tenant the stdio entry
 * resolves on boot (P10). HTTP bearer keys live in `api_keys` and are minted with
 * the keygen script — no env for them.
 */
import { z } from 'zod';

/** docker-compose.yml maps this on the host; .env.example documents it. */
export const DEFAULT_PORT = 8484;

/**
 * One entry of `RECONCIL_TRUST_PROXY`: an IPv4/IPv6 address or CIDR, or one of proxy-addr's
 * named ranges. Validated here rather than left to Fastify because everything else in this
 * file is validated here, and the alternative is worse than a config error: an unparseable
 * value makes `proxy-addr.compile` throw from inside the Fastify constructor, so the
 * process dies at boot with a serialized TypeError that never names the variable.
 */
// The IPv6 alternative requires an actual colon (the lookahead). Without it `[0-9a-fA-F]+`
// happily matches a bare `1`, so the hop-count form this deliberately does not support
// would sail through validation and then throw out of proxy-addr instead.
const PROXY_ENTRY =
  /^(?:loopback|linklocal|uniquelocal|(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?|(?=[^:]*:)[0-9a-fA-F:]+(?:\/\d{1,3})?)$/;

const trustProxyValue = z.string().refine(
  (raw) => {
    const v = raw.trim();
    if (v === '' || v === 'true' || v === 'false') return true;
    return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0).every((s) => PROXY_ENTRY.test(s));
  },
  {
    message:
      'RECONCIL_TRUST_PROXY must be "true", "false", or a comma-separated list of proxy ' +
      'IPs/CIDRs (or loopback/linklocal/uniquelocal). A hop count is not accepted — name ' +
      'the proxies you trust.',
  },
);

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(DEFAULT_PORT),
  SELF_HOST_TENANT_SLUG: z.string().min(1).default('self-host'),
  SELF_HOST_TENANT_NAME: z.string().min(1).default('Self-hosted'),
  // Comma-split Host header allow-list for the streamable-HTTP transport's DNS-
  // rebinding protection (http.ts). Unset ⇒ resolveAllowedHosts derives the default
  // from PORT. See .env.example for the deployment-shaped default.
  RECONCIL_ALLOWED_HOSTS: z.string().optional(),
  // Proxy topology for Fastify's `trustProxy` (http.ts). Unset ⇒ OFF, which is the safe
  // default: see resolveTrustProxy for why turning it on unconditionally would be worse
  // than the problem it solves.
  RECONCIL_TRUST_PROXY: trustProxyValue.optional(),
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

/**
 * Fastify's `trustProxy` value, or `undefined` to leave it off.
 *
 * Off is the default, and deliberately so. With no proxy, `request.ip` is the socket peer
 * and ADR-012 decision 6's per-IP backstop works as intended. Behind a TLS-terminating
 * proxy the peer is the proxy, so every client shares one bucket and the 600/min ceiling
 * degrades from per-client to GLOBAL — that is the bug this setting exists to fix. But
 * turning it on unconditionally is worse, not better: `trustProxy: true` believes any
 * `X-Forwarded-For`, so any client can name its own IP and escape the bucket entirely. A
 * hard ceiling that an attacker can opt out of is not a ceiling. So the operator states
 * their real topology and nobody else's header is trusted.
 *
 * Two accepted forms, both Fastify's own: `true`/`false`, or a comma-separated list of
 * trusted proxy IPs/CIDRs which Fastify hands to proxy-addr. The CIDR list is the form a
 * real deployment should use — it names *which* proxies may speak for a client, where bare
 * `true` only fits a topology in which nothing untrusted can reach the port at all. The
 * shape is validated at load (`trustProxyValue`), so a typo names the variable instead of
 * throwing out of the Fastify constructor.
 *
 * Fastify's hop-count form is deliberately not offered: `trustProxy` dropped `number` from
 * its type in 5.12, and naming the proxies is the better instruction anyway — a hop count
 * trusts whatever sits at that depth, whoever it turns out to be.
 */
export function resolveTrustProxy(
  cfg: Pick<ServerConfig, 'RECONCIL_TRUST_PROXY'>,
): boolean | string | undefined {
  const raw = cfg.RECONCIL_TRUST_PROXY?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

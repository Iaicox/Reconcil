# Worker Ingestion Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `apps/worker` into a BullMQ ingestion host and grow `@pet-crypto/ingestion` into a full pipeline — checkpoint state machine, idempotent `chain_events` writes, receipt-derived erc20 `logIndex` + tx-level from/to, the `receipts-opstack` RPC fee path, and programmatic drizzle `migrate()` on boot.

**Architecture:** All provider I/O and write logic are injected-dependency async functions in `packages/ingestion` (testable against testcontainers Postgres + `FixtureTransport`, no Redis). `apps/worker` is a thin BullMQ adapter that wraps them, registers repeatables, and owns retry/backoff + shutdown. One `eth_getTransactionReceipt` per tx feeds gas, erc20 `logIndex`, and tx-level from/to. Spec: `docs/superpowers/specs/2026-07-18-worker-ingestion-design.md`.

**Tech Stack:** TypeScript strict (NodeNext ESM), Drizzle ORM + `pg`, BullMQ + ioredis, zod v4, vitest, `@testcontainers/postgresql`, Node ≥ 22.12 built-in `fetch`.

## Global Constraints

- **Money is never `number`** (ADR-004): amounts are `bigint` in code / `NUMERIC(78,0)` in DB / decimal strings on the wire. `Number()` may only touch timestamps, log indexes, block numbers.
- **`chain_events` is append-only** (ADR-005): the only write is `INSERT … ON CONFLICT (chain_id, tx_hash, log_index, token_id) DO NOTHING`. No UPDATE/DELETE. Ingestion never queries past `safeHead = head − finalityDepth(chain)`.
- **`err.cause` and raw token strings are hostile** (ADR-011): never `console.log`/interpolate them. Only `serializeError`'s `{name,message,kind}` is logged. `*_raw`/`raw` columns are server-side only.
- **No signing/key library** (P8, dependency-cruiser `no-signing-libraries`): Base RPC is raw JSON-RPC over `fetch`; bullmq/ioredis are clean. `packages/ingestion` imports only `@pet-crypto/db` and `@pet-crypto/core`.
- **No `schema.sql`/migration change** in this slice — the `schema-parity` CI job must stay green.
- **NodeNext ESM**: relative imports in `.ts` need the `.js` extension. TS strict extras: `exactOptionalPropertyTypes` (omit optional keys, never `{k: undefined}`), `noUncheckedIndexedAccess` (indexing returns `T | undefined`).
- Catalog deps: `"zod": "catalog:"`, `"vitest": "catalog:"`, `"tsx": "catalog:"`, `"@types/node": "catalog:"`. New third-party deps pin an explicit caret range.
- Integration tests (`*.itest.ts`) need Docker; they run via a separate `test:integration` script and CI job, **excluded** from the default `test` script so `pnpm test` stays hermetic on machines without Docker.
- `depcruise` resolves through built `dist/` — always `pnpm build` before `pnpm depcruise`.
- Repo language is English (code, comments, commits). Conventional commit messages.

---

### Task 1: `@pet-crypto/core` — logger, `serializeError`, `chains.config` `rpcUrlEnv`

**Files:**
- Create: `packages/core/src/logger.ts`
- Modify: `packages/core/src/chains.config.ts` (add `rpcUrlEnv?`, set for base)
- Modify: `packages/core/src/index.ts` (add exports)
- Test: `packages/core/test/logger.test.ts`, `packages/core/test/chains.config.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `createLogger(opts?: { name?: string }): Logger` where `Logger` has `info/warn/error(msg: string, fields?: Record<string, unknown>): void`; `serializeError(err: unknown): { name: string; message: string; kind?: string }`; `ChainConfig.rpcUrlEnv?: string`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/logger.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createLogger, serializeError } from '../src/logger.js';

describe('serializeError', () => {
  it('never leaks err.cause (hostile provider text)', () => {
    const err = new Error('missing receipt', { cause: 'HOSTILE <script> token name' });
    const out = serializeError(err);
    expect(out).toEqual({ name: 'Error', message: 'missing receipt' });
    expect(JSON.stringify(out)).not.toContain('HOSTILE');
  });

  it('carries a ProviderError-style kind when present', () => {
    class ProviderError extends Error {
      kind = 'rate_limited';
      constructor(m: string) { super(m); this.name = 'ProviderError'; }
    }
    expect(serializeError(new ProviderError('slow down'))).toEqual({
      name: 'ProviderError', message: 'slow down', kind: 'rate_limited',
    });
  });

  it('handles non-Error throwables without leaking their content', () => {
    expect(serializeError({ secret: 'x' })).toEqual({ name: 'NonError', message: 'non-error thrown' });
  });
});

describe('createLogger', () => {
  it('emits one JSON line per call with level, name, msg, fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger({ name: 'worker' }).info('tick', { chainId: 1 });
    expect(spy).toHaveBeenCalledOnce();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: 'info', name: 'worker', msg: 'tick', chainId: 1 });
    expect(typeof line.time).toBe('string');
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @pet-crypto/core exec vitest run test/logger.test.ts`
Expected: FAIL — `Cannot find module '../src/logger.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/logger.ts`:

```ts
/**
 * Structured JSON logger + hostile-safe error serialization (ADR-011). err.cause
 * and raw provider/token strings are hostile: serializeError emits only
 * { name, message, kind? } — never cause, never stack, never raw strings. The
 * message field is adapter/worker-controlled (safe by construction); provider
 * text lives in cause, which we drop.
 */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function serializeError(err: unknown): { name: string; message: string; kind?: string } {
  if (err instanceof Error) {
    const kind = (err as { kind?: unknown }).kind;
    return typeof kind === 'string'
      ? { name: err.name, message: err.message, kind }
      : { name: err.name, message: err.message };
  }
  return { name: 'NonError', message: 'non-error thrown' };
}

export function createLogger(opts?: { name?: string }): Logger {
  const name = opts?.name ?? 'app';
  const emit = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, name, msg, ...fields }));
  };
  return {
    info: (msg, fields) => { emit('info', msg, fields); },
    warn: (msg, fields) => { emit('warn', msg, fields); },
    error: (msg, fields) => { emit('error', msg, fields); },
  };
}
```

- [ ] **Step 4: Run the logger test — expect PASS**

Run: `pnpm --filter @pet-crypto/core exec vitest run test/logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `rpcUrlEnv` to `chains.config.ts`**

In `packages/core/src/chains.config.ts`, add to the `ChainConfig` interface (after `feeStrategy`):

```ts
  readonly rpcUrlEnv?: string; // public JSON-RPC endpoint env var (OP-stack receipts, 03-ingestion §7)
```

And in the base (8453) entry, add after `feeStrategy: 'receipts-opstack',`:

```ts
    rpcUrlEnv: 'BASE_RPC_URL',
```

- [ ] **Step 6: Extend the chains.config test**

Append to `packages/core/test/chains.config.test.ts` inside the `describe`:

```ts
  it('base carries a public-RPC env var for opstack receipts; ethereum does not', () => {
    expect(chainById(8453).rpcUrlEnv).toBe('BASE_RPC_URL');
    expect(chainById(1).rpcUrlEnv).toBeUndefined();
  });
```

- [ ] **Step 7: Export from index and run full core suite**

In `packages/core/src/index.ts` add:

```ts
export { createLogger, serializeError, type Logger } from './logger.js';
```

Run: `pnpm --filter @pet-crypto/core exec vitest run`
Expected: PASS (logger + chains.config).

- [ ] **Step 8: Build + lint + commit**

```bash
pnpm --filter @pet-crypto/core build && pnpm --filter @pet-crypto/core lint
git add packages/core
git commit -m "feat(core): structured logger + serializeError (drops err.cause); chains rpcUrlEnv"
```

---

### Task 2: `@pet-crypto/db` — programmatic `runMigrations(pool)`

**Files:**
- Create: `packages/db/src/migrate.ts`
- Modify: `packages/db/src/index.ts` (export)
- Modify: `packages/db/package.json` (devDep `@testcontainers/postgresql`, `test:integration` script)
- Create: `packages/db/test/migrate.itest.ts`
- Create: `packages/db/vitest.config.ts`, `packages/db/vitest.integration.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `runMigrations(pool: Pool): Promise<void>` — applies `packages/db/migrations` via `drizzle-orm/node-postgres/migrator`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/test/migrate.itest.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';

describe('runMigrations', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('creates the schema on a fresh database', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toContain('chain_events');
    expect(names).toContain('ingestion_checkpoints');
    expect(names).toContain('tokens');
  });

  it('is idempotent — a second run is a no-op', async () => {
    await expect(runMigrations(pool)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Add the testcontainers devDep and split vitest configs**

In `packages/db/package.json`, add to `devDependencies`:

```json
    "@testcontainers/postgresql": "^11.0.0",
```

and to `scripts`:

```json
    "test:integration": "vitest run --config vitest.integration.config.ts",
```

Create `packages/db/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
// Default suite: hermetic only. Integration (*.itest.ts) needs Docker — see
// vitest.integration.config.ts, run via `pnpm test:integration`.
export default defineConfig({ test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts'] } });
```

Create `packages/db/vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['**/*.itest.ts'], testTimeout: 120_000, hookTimeout: 120_000 } });
```

Run: `pnpm install`
Expected: `@testcontainers/postgresql` resolved.

- [ ] **Step 3: Run the integration test to verify it fails**

Run: `pnpm --filter @pet-crypto/db test:integration`
Expected: FAIL — `Cannot find module '../src/migrate.js'`. (Requires Docker running.)

- [ ] **Step 4: Write the implementation**

Create `packages/db/src/migrate.ts`:

```ts
/**
 * Programmatic migrations for app startup (worker boot) — ADR-002. Uses the
 * hand-auditable SQL in ./migrations, NOT drizzle-kit (which is dev tooling).
 * Path resolves the same under tsc dist and vitest src: ../migrations from this
 * module is packages/db/migrations in both.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder });
}
```

- [ ] **Step 5: Export and run the integration test — expect PASS**

In `packages/db/src/index.ts` add:

```ts
export { runMigrations } from './migrate.js';
```

Run: `pnpm --filter @pet-crypto/db test:integration`
Expected: PASS (both tests).

- [ ] **Step 6: Build + lint + commit**

```bash
pnpm --filter @pet-crypto/db build && pnpm --filter @pet-crypto/db lint
git add packages/db pnpm-lock.yaml
git commit -m "feat(db): programmatic runMigrations(pool) via drizzle node-postgres migrator"
```

---

### Task 3: `@pet-crypto/ingestion` types + receipt adapters gain logs / from / to

**Files:**
- Modify: `packages/ingestion/src/types.ts` (add `RawLog`; extend `RawReceipt`, `NormalizedEvent`)
- Modify: `packages/ingestion/src/providers/etherscan-v2.ts` (`receiptResult` + `mapReceipt`)
- Create: `packages/ingestion/test/receipt.test.ts`
- Create: `packages/ingestion/test/fixtures-receipt/*.json` (hand-written)

**Interfaces:**
- Consumes: `hexQuantity` from `providers/envelope.js`.
- Produces: `RawLog { logIndex: number; address: string; topics: string[]; data: string }`; `RawReceipt` gains `from: string`, `to: string | null`, `logs: RawLog[]`.
- Deferred to Task 6: the `NormalizedEvent` extension (`txFrom`/`txTo`/`raw` + erc20 token metadata) lands with the `normalize()` change so the build never sees a half-updated constructor.

- [ ] **Step 1: Write the failing test**

Create `packages/ingestion/test/receipt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapReceipt, receiptResult } from '../src/providers/etherscan-v2.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

describe('mapReceipt with logs', () => {
  it('maps from/to and decodes hex logIndex, lowercasing addresses', () => {
    const raw = receiptResult.parse({
      transactionHash: '0xABC',
      from: '0xFromEOA',
      to: '0xToContract',
      gasUsed: '0x5208',
      effectiveGasPrice: '0x3b9aca00',
      status: '0x1',
      l1Fee: '0x64',
      logs: [
        { logIndex: '0x2', address: '0xTokenC', topics: [TRANSFER, '0x1', '0x2'], data: '0x0a' },
      ],
    });
    const r = mapReceipt(raw);
    expect(r.transactionHash).toBe('0xabc');
    expect(r.from).toBe('0xfromeoa');
    expect(r.to).toBe('0xtocontract');
    expect(r.l1Fee).toBe('100');
    expect(r.logs).toEqual([
      { logIndex: 2, address: '0xtokenc', topics: [TRANSFER, '0x1', '0x2'], data: '0x0a' },
    ]);
  });

  it('accepts a null tx-level to (contract creation) and an empty logs array', () => {
    const r = mapReceipt(
      receiptResult.parse({
        transactionHash: '0xdef', from: '0xa', to: null,
        gasUsed: '0x1', effectiveGasPrice: '0x1', status: '0x1', logs: [],
      }),
    );
    expect(r.to).toBeNull();
    expect(r.logs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @pet-crypto/ingestion exec vitest run test/receipt.test.ts`
Expected: FAIL — `receiptResult` has no `logs`/`from`/`to` (Zod strips/rejects), `RawReceipt` has no `logs`.

- [ ] **Step 3: Extend the types**

In `packages/ingestion/src/types.ts`, add `RawLog` and extend `RawReceipt`:

```ts
export interface RawLog {
  logIndex: number;   // decoded from hex at the adapter boundary
  address: string;    // emitting contract (lowercase)
  topics: string[];   // topic0 = event sig; ERC-20 Transfer has exactly 3 topics
  data: string;       // 0x-hex; ERC-20 Transfer value
}

export interface RawReceipt {
  transactionHash: string;
  from: string;       // tx-level sender (lowercase) → chain_events.tx_from
  to: string | null;  // tx-level target (lowercase) → chain_events.tx_to; null on contract creation
  gasUsed: string;
  effectiveGasPrice: string;
  l1Fee: string | null;
  status: '0' | '1';
  logs: RawLog[];
}
```

(Leave `NormalizedEvent` unchanged in this task — it is extended in Task 6 together with `normalize()`.)

- [ ] **Step 4: Extend `receiptResult` + `mapReceipt`**

In `packages/ingestion/src/providers/etherscan-v2.ts`, replace the `receiptResult` schema and `mapReceipt`:

```ts
const logEntry = z.object({
  logIndex: hexQuantity,
  address: z.string(),
  topics: z.array(z.string()),
  data: z.string(),
});

const receiptResult = z.object({
  transactionHash: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  gasUsed: hexQuantity,
  effectiveGasPrice: hexQuantity,
  status: z.enum(['0x0', '0x1']),
  l1Fee: hexQuantity.optional(),
  logs: z.array(logEntry),
});

export function mapReceipt(r: z.infer<typeof receiptResult>): RawReceipt {
  return {
    transactionHash: r.transactionHash.toLowerCase(),
    from: r.from.toLowerCase(),
    to: r.to === null ? null : r.to.toLowerCase(),
    gasUsed: BigInt(r.gasUsed).toString(),
    effectiveGasPrice: BigInt(r.effectiveGasPrice).toString(),
    l1Fee: r.l1Fee === undefined ? null : BigInt(r.l1Fee).toString(),
    status: r.status === '0x1' ? '1' : '0',
    logs: r.logs.map((l) => ({
      logIndex: Number(BigInt(l.logIndex)),
      address: l.address.toLowerCase(),
      topics: l.topics,
      data: l.data,
    })),
  };
}
```

- [ ] **Step 5: Run the receipt test — expect PASS**

Run: `pnpm --filter @pet-crypto/ingestion exec vitest run test/receipt.test.ts`
Expected: PASS.

- [ ] **Step 6: Build + lint + commit**

```bash
pnpm --filter @pet-crypto/ingestion build && pnpm --filter @pet-crypto/ingestion lint
git add packages/ingestion
git commit -m "feat(ingestion): RawLog + receipt logs/from/to on RawReceipt and mapReceipt"
```

> NB: `normalize.ts` and the existing adapter/golden tests are untouched and still build — this task only widens `RawReceipt`. The `NormalizedEvent` extension is Task 6.

---

### Task 4: RPC receipt path + provider factory with ordered failover

**Files:**
- Create: `packages/ingestion/src/providers/rpc.ts`
- Create: `packages/ingestion/src/providers/provider-factory.ts`
- Test: `packages/ingestion/test/rpc.test.ts`, `packages/ingestion/test/provider-factory.test.ts`

**Interfaces:**
- Consumes: `etherscanV2Adapter`, `blockscoutAdapter`, `mapReceipt`, `receiptResult`, `parseRows`, `chainById`, `ProviderError`, `RawReceipt`, `ChainDataProvider`, `FetchJson`.
- Produces: `type RpcCall = (method: string, params: unknown[]) => Promise<unknown>`; `httpRpcCall(url: string): RpcCall`; `rpcGetReceipts(rpc: RpcCall, hashes: string[]): Promise<RawReceipt[]>`; `failoverProvider(providers: ChainDataProvider[]): ChainDataProvider`; `buildProviderBundle(opts): ProviderBundle` where `ProviderBundle = { indexer: ChainDataProvider; getReceipts(hashes: string[]): Promise<RawReceipt[]> }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/ingestion/test/rpc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { rpcGetReceipts, type RpcCall } from '../src/providers/rpc.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

describe('rpcGetReceipts', () => {
  it('maps a JSON-RPC receipt result via the shared receipt schema', async () => {
    const rpc: RpcCall = vi.fn(async (method: string, params: unknown[]) => {
      expect(method).toBe('eth_getTransactionReceipt');
      expect(params).toEqual(['0xabc']);
      return {
        transactionHash: '0xABC', from: '0xEOA', to: '0xC',
        gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', status: '0x1', l1Fee: '0x0',
        logs: [{ logIndex: '0x0', address: '0xTok', topics: [TRANSFER, '0x1', '0x2'], data: '0x01' }],
      };
    });
    const [r] = await rpcGetReceipts(rpc, ['0xabc']);
    expect(r!.from).toBe('0xeoa');
    expect(r!.logs[0]!.logIndex).toBe(0);
  });
});
```

Create `packages/ingestion/test/provider-factory.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { failoverProvider, buildProviderBundle } from '../src/providers/provider-factory.js';
import { ProviderError, type ChainDataProvider } from '../src/types.js';

const stub = (over: Partial<ChainDataProvider>): ChainDataProvider => ({
  kind: 'etherscan-v2',
  getHead: async () => 1n,
  getNativeTxs: async () => ({ items: [] }),
  getErc20Transfers: async () => ({ items: [] }),
  ...over,
});

describe('failoverProvider', () => {
  it('falls through to the secondary on a ProviderError and reports the served kind', async () => {
    const primary = stub({ kind: 'etherscan-v2', getHead: async () => { throw new ProviderError('provider_error', 'no base'); } });
    const secondary = stub({ kind: 'blockscout', getHead: async () => 42n });
    const fp = failoverProvider([primary, secondary]);
    expect(await fp.getHead(8453)).toBe(42n);
    expect(fp.kind).toBe('blockscout');
  });

  it('rethrows when every provider fails', async () => {
    const boom = stub({ getHead: async () => { throw new ProviderError('http', 'HTTP 500'); } });
    await expect(failoverProvider([boom, boom]).getHead(1)).rejects.toThrow(ProviderError);
  });
});

describe('buildProviderBundle', () => {
  it('routes receipts to the injected RPC on receipts-opstack chains (base)', async () => {
    const rpcCall = vi.fn(async () => ({
      transactionHash: '0x1', from: '0xa', to: '0xb',
      gasUsed: '0x1', effectiveGasPrice: '0x1', status: '0x1', logs: [],
    }));
    const bundle = buildProviderBundle({
      chainId: 8453,
      env: { BASE_RPC_URL: 'https://rpc.example' },
      fetchJson: async () => ({ status: 200, body: {} }),
      rpcCallFor: () => rpcCall,
    });
    const [r] = await bundle.getReceipts(['0x1']);
    expect(r!.from).toBe('0xa');
    expect(rpcCall).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @pet-crypto/ingestion exec vitest run test/rpc.test.ts test/provider-factory.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `rpc.ts`**

```ts
/**
 * Public JSON-RPC receipt path (03-ingestion §6): Base receipts come from a
 * public node, not the indexer APIs. Raw JSON-RPC over fetch — NO signing/RPC
 * library (P8). POST-only, so it does not use the GET-shaped FetchJson seam.
 */
import { ProviderError, type RawReceipt } from '../types.js';
import { mapReceipt, receiptResult } from './etherscan-v2.js';
import { parseRows } from './envelope.js';

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export function httpRpcCall(url: string): RpcCall {
  return async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429) throw new ProviderError('rate_limited', 'HTTP 429');
    if (!res.ok) throw new ProviderError('http', `HTTP ${String(res.status)}`);
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    // Never embed json.error — RPC error text is hostile (ADR-011).
    if (json.error !== undefined) throw new ProviderError('provider_error', 'rpc returned an error');
    return json.result;
  };
}

export async function rpcGetReceipts(rpc: RpcCall, hashes: string[]): Promise<RawReceipt[]> {
  const out: RawReceipt[] = [];
  for (const hash of hashes) {
    const result = await rpc('eth_getTransactionReceipt', [hash]);
    out.push(mapReceipt(parseRows(receiptResult, result)));
  }
  return out;
}
```

- [ ] **Step 4: Write `provider-factory.ts`**

```ts
/**
 * Config + env → providers (ADR-009). Ordered failover: etherscan-v2 primary,
 * blockscout secondary — this also routes Base indexer calls, since the etherscan
 * free tier errors on chain 8453 and the failover falls through (spec §7).
 * Receipts route to the public RPC on receipts-opstack chains, to the indexer
 * otherwise.
 */
import { chainById } from '@pet-crypto/core';
import { ProviderError, type ChainDataProvider, type FetchJson, type PageQuery, type RawReceipt } from '../types.js';
import { etherscanV2Adapter } from './etherscan-v2.js';
import { blockscoutAdapter } from './blockscout.js';
import { httpRpcCall, rpcGetReceipts, type RpcCall } from './rpc.js';

export interface ProviderBundle {
  indexer: ChainDataProvider;
  getReceipts(hashes: string[]): Promise<RawReceipt[]>;
}

export function failoverProvider(providers: ChainDataProvider[]): ChainDataProvider {
  // `served` records which provider last answered so the caller can stamp the
  // real provider onto each event row (ADR-009 audit). A processor runs one
  // fetch per ingestOnce, then reads `.kind` — no interleaving to race.
  let served = providers[0]?.kind ?? 'etherscan-v2';
  const attempt = async <T>(fn: (p: ChainDataProvider) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const p of providers) {
      try {
        const out = await fn(p);
        served = p.kind;
        return out;
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        last = err;
      }
    }
    throw last;
  };
  return {
    get kind() { return served; },
    getHead: (chainId) => attempt((p) => p.getHead(chainId)),
    getNativeTxs: (q: PageQuery) => attempt((p) => p.getNativeTxs(q)),
    getErc20Transfers: (q: PageQuery) => attempt((p) => p.getErc20Transfers(q)),
  };
}

export function buildProviderBundle(opts: {
  chainId: number;
  env: Record<string, string | undefined>;
  fetchJson: FetchJson;
  rpcCallFor?: (url: string) => RpcCall;
}): ProviderBundle {
  const chain = chainById(opts.chainId);
  const [primaryCfg, secondaryCfg] = chain.providers;
  if (!primaryCfg || !secondaryCfg) throw new Error(`chain ${String(opts.chainId)} needs two providers`);

  const etherscan = etherscanV2Adapter({
    fetchJson: opts.fetchJson,
    baseUrl: primaryCfg.baseUrl,
    apiKey: (primaryCfg.apiKeyEnv ? opts.env[primaryCfg.apiKeyEnv] : undefined) ?? '',
  });
  const blockscout = blockscoutAdapter({
    fetchJson: opts.fetchJson,
    baseUrl: secondaryCfg.baseUrl,
    chainId: opts.chainId,
  });
  const indexer = failoverProvider([etherscan, blockscout]);

  const getReceipts = async (hashes: string[]): Promise<RawReceipt[]> => {
    if (chain.feeStrategy === 'receipts-opstack') {
      const url = chain.rpcUrlEnv ? opts.env[chain.rpcUrlEnv] : undefined;
      if (!url) throw new Error(`${chain.rpcUrlEnv ?? 'rpcUrlEnv'} is required for chain ${chain.name}`);
      const rpc = (opts.rpcCallFor ?? httpRpcCall)(url);
      return rpcGetReceipts(rpc, hashes);
    }
    return etherscan.getReceipts?.(opts.chainId, hashes) ?? [];
  };

  return { indexer, getReceipts };
}
```

- [ ] **Step 5: Run the tests — expect PASS**

Run: `pnpm --filter @pet-crypto/ingestion exec vitest run test/rpc.test.ts test/provider-factory.test.ts`
Expected: PASS.

- [ ] **Step 6: Build + lint + commit**

```bash
pnpm --filter @pet-crypto/ingestion build && pnpm --filter @pet-crypto/ingestion lint
git add packages/ingestion
git commit -m "feat(ingestion): JSON-RPC receipt path + provider factory with ordered failover"
```

---

### Task 5: `logindex.ts` — receipt-derived erc20 logIndex + tx-level from/to (pure)

**Files:**
- Create: `packages/ingestion/src/logindex.ts`
- Test: `packages/ingestion/test/logindex.test.ts`

**Interfaces:**
- Consumes: `RawErc20Transfer`, `RawReceipt` from `types.js`.
- Produces: `interface Erc20WithMeta extends RawErc20Transfer { logIndex: string; txFrom: string; txTo: string | null }`; `assignErc20Metadata(rows: RawErc20Transfer[], receiptsByHash: ReadonlyMap<string, RawReceipt>): Erc20WithMeta[]` — throws on missing receipt / unmatched transfer.

- [ ] **Step 1: Write the failing test**

Create `packages/ingestion/test/logindex.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assignErc20Metadata } from '../src/logindex.js';
import type { RawErc20Transfer, RawReceipt } from '../src/types.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (addr: string): string => '0x' + addr.slice(2).padStart(64, '0');
const val = (n: bigint): string => '0x' + n.toString(16);
// Full 20-byte (40-hex) addresses: a real address survives pad()→topicAddr()
// round-trip (topicAddr takes the low 20 bytes). Short stubs like '0xaaa' would
// not — topicAddr('0x00…00aaa') is '0x00…00aaa', never '0xaaa'.
const AAA = '0x' + 'a'.repeat(40);
const BBB = '0x' + 'b'.repeat(40);

const row = (over: Partial<RawErc20Transfer>): RawErc20Transfer => ({
  blockNumber: '100', timeStamp: '1700000000', hash: '0xtx', logIndex: null,
  from: AAA, to: BBB, contractAddress: '0xtok', value: '5',
  tokenName: 'T', tokenSymbol: 'T', tokenDecimal: '18', ...over,
});

const receipt = (logs: RawReceipt['logs']): RawReceipt => ({
  transactionHash: '0xtx', from: '0xsender', to: '0xrouter',
  gasUsed: '1', effectiveGasPrice: '1', l1Fee: null, status: '1', logs,
});

describe('assignErc20Metadata', () => {
  it('assigns the matching log index and tx-level from/to', () => {
    const rec = receipt([
      { logIndex: 7, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) },
    ]);
    const [out] = assignErc20Metadata([row({})], new Map([['0xtx', rec]]));
    expect(out!.logIndex).toBe('7');
    expect(out!.txFrom).toBe('0xsender');
    expect(out!.txTo).toBe('0xrouter');
  });

  it('gives duplicate identical transfers distinct indexes in ascending order', () => {
    const rec = receipt([
      { logIndex: 9, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) },
      { logIndex: 4, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) },
    ]);
    const out = assignErc20Metadata([row({}), row({})], new Map([['0xtx', rec]]));
    expect(out.map((r) => r.logIndex).sort()).toEqual(['4', '9']);
  });

  it('ignores ERC-721 Transfer logs (4 topics)', () => {
    const rec = receipt([
      { logIndex: 1, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB), pad('0x01')], data: '0x' },
      { logIndex: 2, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) },
    ]);
    const [out] = assignErc20Metadata([row({})], new Map([['0xtx', rec]]));
    expect(out!.logIndex).toBe('2');
  });

  it('throws when the receipt is missing', () => {
    expect(() => assignErc20Metadata([row({})], new Map())).toThrow(/receipt/i);
  });

  it('throws when no log matches the transfer', () => {
    const rec = receipt([{ logIndex: 0, address: '0xother', topics: [TRANSFER, pad(AAA), pad(BBB)], data: val(5n) }]);
    expect(() => assignErc20Metadata([row({})], new Map([['0xtx', rec]]))).toThrow(/no matching/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @pet-crypto/ingestion exec vitest run test/logindex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/ingestion/src/logindex.ts`:

```ts
/**
 * Receipt-derived erc20 logIndex + tx-level from/to (spec §11, resolution option
 * 3). No provider returns logIndex in tokentx; the receipt's Transfer logs carry
 * the exact, provider-independent index. Match by (contract, from, to, value),
 * consuming logs in ascending logIndex so duplicate identical transfers get
 * distinct indexes. Missing receipt / unmatched row throws — synthetic ordinals
 * (option 4) stay rejected. Pure: no I/O.
 */
import type { RawErc20Transfer, RawLog, RawReceipt } from './types.js';

export interface Erc20WithMeta extends RawErc20Transfer {
  logIndex: string;
  txFrom: string;
  txTo: string | null;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicAddr = (topic: string): string => ('0x' + topic.slice(-40)).toLowerCase();

export function assignErc20Metadata(
  rows: RawErc20Transfer[],
  receiptsByHash: ReadonlyMap<string, RawReceipt>,
): Erc20WithMeta[] {
  // Group rows per tx so we consume each receipt's logs independently.
  const consumedByHash = new Map<string, Set<number>>();

  return rows.map((r) => {
    const hash = r.hash.toLowerCase();
    const receipt = receiptsByHash.get(hash);
    if (!receipt) throw new Error('missing receipt for erc20 transfer', { cause: hash });

    const consumed = consumedByHash.get(hash) ?? new Set<number>();
    consumedByHash.set(hash, consumed);

    const candidates = receipt.logs
      .filter(
        (l): l is RawLog =>
          l.topics.length === 3 &&
          l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
          l.address === r.contractAddress.toLowerCase() &&
          !consumed.has(l.logIndex),
      )
      .sort((a, b) => a.logIndex - b.logIndex);

    const from = r.from.toLowerCase();
    const to = r.to.toLowerCase();
    const value = BigInt(r.value);
    const match = candidates.find(
      (l) => topicAddr(l.topics[1]!) === from && topicAddr(l.topics[2]!) === to && BigInt(l.data) === value,
    );
    if (!match) throw new Error('no matching Transfer log for erc20 transfer', { cause: hash });

    consumed.add(match.logIndex);
    return { ...r, logIndex: String(match.logIndex), txFrom: receipt.from, txTo: receipt.to };
  });
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `pnpm --filter @pet-crypto/ingestion exec vitest run test/logindex.test.ts`
Expected: PASS.

- [ ] **Step 5: Build + lint + commit**

```bash
pnpm --filter @pet-crypto/ingestion build && pnpm --filter @pet-crypto/ingestion lint
git add packages/ingestion
git commit -m "feat(ingestion): assignErc20Metadata — receipt-derived logIndex + tx from/to"
```

---

### Task 6: `normalize()` — tx-level fields, receipt-enriched erc20, `raw`

**Files:**
- Modify: `packages/ingestion/src/types.ts` (extend `NormalizedEvent`)
- Modify: `packages/ingestion/src/normalize.ts`
- Modify: `packages/ingestion/test/normalize.test.ts` (extend)

**Interfaces:**
- Consumes: `Erc20WithMeta` from `logindex.js`; `RawNativeTx`, `RawReceipt`.
- Produces: `NormalizedEvent` gains `txFrom: string`, `txTo: string | null`, `raw: unknown`, and the erc20 `token` variant gains `decimals: string; symbolRaw: string; nameRaw: string`; `normalize(input: { native?: Page<RawNativeTx>; erc20?: Page<Erc20WithMeta> }, ctx: NormalizeContext): NormalizedEvent[]`.

- [ ] **Step 1: Write the failing test**

Append to `packages/ingestion/test/normalize.test.ts`:

```ts
import { assignErc20Metadata } from '../src/logindex.js';

describe('normalize — tx-level fields and erc20 enrichment', () => {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a: string): string => '0x' + a.slice(2).padStart(64, '0');
  // Full 20-byte addresses so pad()→topicAddr() round-trips (see Task 5).
  const AAA = '0x' + 'a'.repeat(40);
  const BBB = '0x' + 'b'.repeat(40);

  it('native + gas carry txFrom/txTo and raw', () => {
    const tx = {
      blockNumber: '10', timeStamp: '1700000000', hash: '0xTX',
      from: '0xTRACKED', to: '0xDEST', value: '1000', gasUsed: '21000', gasPrice: '2', isError: '0' as const,
    };
    const events = normalize({ native: { items: [tx] } }, {
      chainId: 1, trackedAddress: '0xtracked', feeStrategy: 'txlist', provider: 'etherscan-v2',
    });
    const gas = events.find((e) => e.eventKind === 'gas_fee')!;
    expect(gas.txFrom).toBe('0xtracked');
    expect(gas.txTo).toBe('0xdest');
    expect(gas.raw).toBe(tx);
  });

  it('erc20 events take logIndex + txFrom/txTo from the receipt and expose token metadata', () => {
    const row = {
      blockNumber: '10', timeStamp: '1700000000', hash: '0xtx', logIndex: null,
      from: AAA, to: BBB, contractAddress: '0xTOK', value: '5',
      tokenName: 'Acme', tokenSymbol: 'ACME', tokenDecimal: '6',
    };
    const receipt = {
      transactionHash: '0xtx', from: '0xsender', to: '0xrouter', gasUsed: '1', effectiveGasPrice: '1',
      l1Fee: null, status: '1' as const,
      logs: [{ logIndex: 3, address: '0xtok', topics: [TRANSFER, pad(AAA), pad(BBB)], data: '0x05' }],
    };
    const enriched = assignErc20Metadata([row], new Map([['0xtx', receipt]]));
    const [e] = normalize({ erc20: { items: enriched } }, {
      chainId: 1, trackedAddress: AAA, feeStrategy: 'txlist', provider: 'etherscan-v2',
    });
    expect(e!.logIndex).toBe(3);
    expect(e!.txFrom).toBe('0xsender');
    expect(e!.token).toEqual({ kind: 'erc20', contract: '0xtok', decimals: '6', symbolRaw: 'ACME', nameRaw: 'Acme' });
    expect(e!.amountRaw).toBe(5n);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @pet-crypto/ingestion exec vitest run test/normalize.test.ts`
Expected: FAIL — `txFrom`/`raw`/token metadata absent; erc20 branch still expects `RawErc20Transfer`.

- [ ] **Step 3: Extend `NormalizedEvent`**

In `packages/ingestion/src/types.ts` replace the `token` field and add the trailing fields (as specified in this task's Interfaces block):

```ts
  token:
    | { kind: 'native' }
    | { kind: 'erc20'; contract: string; decimals: string; symbolRaw: string; nameRaw: string };
  // …existing fields…
  txFrom: string;      // lowercase; tx-level sender
  txTo: string | null; // lowercase; null on contract creation
  raw: unknown;        // source provider row → chain_events.raw (server-side only, NOT NULL)
```

- [ ] **Step 4: Update `normalize.ts`**

Change the `input` erc20 type to `Page<Erc20WithMeta>`, add `import type { Erc20WithMeta } from './logindex.js';`, and update both branches. Native/gas events add:

```ts
    const txFrom = from;                                   // tx-level sender = row.from
    const txTo = tx.to === null ? null : tx.to.toLowerCase();
```

then include `txFrom, txTo, raw: tx` in both the `native_transfer` and `gas_fee` pushes (for `gas_fee`, `fromAddr`/`toAddr` stay as today; `txFrom`/`txTo` describe the tx, not the fee leg).

Replace the erc20 loop with (rows are already receipt-enriched — no more `throw` on null):

```ts
  for (const t of input.erc20?.items ?? []) {
    events.push({
      chainId: ctx.chainId,
      txHash: t.hash.toLowerCase(),
      logIndex: Number(t.logIndex),
      eventKind: 'erc20_transfer',
      token: {
        kind: 'erc20',
        contract: t.contractAddress.toLowerCase(),
        decimals: t.tokenDecimal,
        symbolRaw: t.tokenSymbol,
        nameRaw: t.tokenName,
      },
      fromAddr: t.from.toLowerCase(),
      toAddr: t.to.toLowerCase(),
      amountRaw: BigInt(t.value),
      blockNumber: BigInt(t.blockNumber),
      blockTime: new Date(Number(t.timeStamp) * 1000),
      provider: ctx.provider,
      txFrom: t.txFrom,
      txTo: t.txTo,
      raw: t,
    });
  }
```

- [ ] **Step 5: Run the normalize suite — expect PASS**

Run: `pnpm --filter @pet-crypto/ingestion exec vitest run test/normalize.test.ts`
Expected: PASS. Fix any older normalize cases that build `NormalizedEvent` expectations by hand (add the new fields to their expected objects — the golden native/gas counts are unchanged).

- [ ] **Step 6: Build + full ingestion suite + lint + commit**

Run: `pnpm --filter @pet-crypto/ingestion build && pnpm --filter @pet-crypto/ingestion exec vitest run && pnpm --filter @pet-crypto/ingestion lint`
Expected: PASS.

```bash
git add packages/ingestion
git commit -m "feat(ingestion): normalize fills tx-level from/to + raw; erc20 consumes receipt-enriched rows"
```

---

### Task 7: Write layer — token upsert, event writer, transactional checkpoint

**Files:**
- Create: `packages/ingestion/src/write/token-repo.ts`, `packages/ingestion/src/write/event-writer.ts`, `packages/ingestion/src/write/checkpoint-repo.ts`
- Modify: `packages/ingestion/package.json` (devDep `@testcontainers/postgresql`, `test:integration` script), add `packages/ingestion/vitest.config.ts` + `vitest.integration.config.ts` (mirror Task 2)
- Create: `packages/ingestion/test/write.itest.ts`

**Interfaces:**
- Consumes: `chainEvents`, `tokens`, `ingestionCheckpoints`, `createDb`, `Db` from `@pet-crypto/db`; `and`, `eq`, `isNull` from `drizzle-orm`; `chainById`, `ChainConfig` from `@pet-crypto/core`; `NormalizedEvent`.
- Produces: `tokenInsertValues(ev, chain): typeof tokens.$inferInsert`; `toChainEventRow(ev, tokenId): typeof chainEvents.$inferInsert`; `insertEventRows(db: Db, rows): Promise<number>`; `getCheckpoint(db, chainId, address, stream): Promise<CheckpointRow | undefined>`; `seedCheckpoint(db, chainId, address, stream): Promise<void>`; `commitPage(db, target, events, next, chain): Promise<number>` where `target = BackfillTarget`, `next = { lastProcessedBlock: number; status: 'backfilling' | 'live' }`.

- [ ] **Step 1: Add testcontainers wiring (mirror Task 2)**

In `packages/ingestion/package.json` add `"@testcontainers/postgresql": "^11.0.0"` to `devDependencies` and `"test:integration": "vitest run --config vitest.integration.config.ts"` to `scripts`. Create `vitest.config.ts` and `vitest.integration.config.ts` identical to Task 2 (default excludes `**/*.itest.ts`; integration includes them with 120 s timeouts). Run `pnpm install`.

- [ ] **Step 2: Write the failing integration test**

Create `packages/ingestion/test/write.itest.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type Db } from '@pet-crypto/db';
import { runMigrations } from '@pet-crypto/db';
import { chainById } from '@pet-crypto/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../src/types.js';
import { commitPage, getCheckpoint, seedCheckpoint } from '../src/write/checkpoint-repo.js';
import { insertEventRows } from '../src/write/event-writer.js';
import { toChainEventRow } from '../src/write/event-writer.js';
import { tokenInsertValues } from '../src/write/token-repo.js';

const chain = chainById(1);
const ADDR = '0xaaa0000000000000000000000000000000000001';

const nativeEvent = (block: number, logIndex: number): NormalizedEvent => ({
  chainId: 1, txHash: `0xtx${block}`, logIndex, eventKind: logIndex === -2 ? 'gas_fee' : 'native_transfer',
  token: { kind: 'native' }, fromAddr: ADDR, toAddr: '0xbbb0000000000000000000000000000000000002',
  amountRaw: 1000n, blockNumber: BigInt(block), blockTime: new Date('2024-01-01T00:00:00Z'),
  provider: 'etherscan-v2', txFrom: ADDR, txTo: '0xbbb0000000000000000000000000000000000002', raw: {},
});

describe('write layer', () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    db = createDb(pool);
  }, 120_000);

  afterAll(async () => { await pool.end(); await container.stop(); });

  it('commitPage upserts the native token, inserts events, advances the cursor', async () => {
    await seedCheckpoint(db, 1, ADDR, 'native');
    const inserted = await commitPage(db, { chainId: 1, address: ADDR, stream: 'native' },
      [nativeEvent(100, -1), nativeEvent(100, -2)], { lastProcessedBlock: 100, status: 'live' }, chain);
    expect(inserted).toBe(2);
    const cp = await getCheckpoint(db, 1, ADDR, 'native');
    expect(cp).toMatchObject({ status: 'live', lastProcessedBlock: 100 });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM chain_events');
    expect(rows[0].n).toBe(2);
  });

  it('is idempotent — re-committing the same events inserts nothing new', async () => {
    const again = await commitPage(db, { chainId: 1, address: ADDR, stream: 'native' },
      [nativeEvent(100, -1), nativeEvent(100, -2)], { lastProcessedBlock: 100, status: 'live' }, chain);
    expect(again).toBe(0);
  });

  it('inv.6 — write-chunk size does not change the ledger', async () => {
    await pool.query('TRUNCATE chain_events CASCADE'); // matches FKs chain_events.id; CASCADE required (matches is empty here)
    const events = Array.from({ length: 250 }, (_, i) => nativeEvent(1000 + i, -1));
    // resolve one native token id, build rows once
    const chunkInsert = async (size: number): Promise<string[]> => {
      await pool.query('TRUNCATE chain_events CASCADE'); // matches FKs chain_events.id; CASCADE required (matches is empty here)
      const tid = (await pool.query(`SELECT id FROM tokens WHERE chain_id=1 AND address IS NULL`)).rows[0].id as number;
      const rows = events.map((e) => toChainEventRow(e, tid));
      for (let i = 0; i < rows.length; i += size) await insertEventRows(db, rows.slice(i, i + size));
      const r = await pool.query('SELECT tx_hash FROM chain_events ORDER BY tx_hash');
      return r.rows.map((x) => x.tx_hash as string);
    };
    const a = await chunkInsert(10); const b = await chunkInsert(100); const c = await chunkInsert(1000);
    expect(a).toEqual(b); expect(b).toEqual(c); expect(a.length).toBe(250);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @pet-crypto/ingestion test:integration`
Expected: FAIL — write modules not found. (Docker required.)

- [ ] **Step 4: Write `token-repo.ts`**

```ts
/**
 * Minimal inline token upsert (token-resolve queue is deferred). Native is a
 * pseudo-token (address NULL); erc20 rows are verified=false with raw hostile
 * strings and NULL display until a later token-resolve slice. decimals is
 * coerced into the DDL's 0..36 CHECK — the base-unit ledger stays exact.
 */
import type { ChainConfig } from '@pet-crypto/core';
import { tokens } from '@pet-crypto/db';
import type { NormalizedEvent } from '../types.js';

export function tokenKey(ev: NormalizedEvent): string {
  return ev.token.kind === 'native' ? `native:${String(ev.chainId)}` : `${String(ev.chainId)}:${ev.token.contract}`;
}

export function tokenInsertValues(ev: NormalizedEvent, chain: ChainConfig): typeof tokens.$inferInsert {
  if (ev.token.kind === 'native') {
    return {
      chainId: ev.chainId, address: null, standard: 'native',
      symbolRaw: chain.native.symbol, nameRaw: chain.native.symbol,
      decimals: chain.native.decimals, verified: false,
    };
  }
  const d = Number(ev.token.decimals);
  const decimals = Number.isInteger(d) && d >= 0 && d <= 36 ? d : 0;
  return {
    chainId: ev.chainId, address: ev.token.contract, standard: 'erc20',
    symbolRaw: ev.token.symbolRaw, nameRaw: ev.token.nameRaw,
    decimals, verified: false,
  };
}
```

- [ ] **Step 5: Write `event-writer.ts`**

```ts
/**
 * NormalizedEvent → chain_events insert row, and a batch insert that is the ONLY
 * write path (append-only, ADR-005): INSERT … ON CONFLICT (chain_id, tx_hash,
 * log_index, token_id) DO NOTHING. blockNumber is mode 'number' (< 2^53, not
 * money); amountRaw is bigint (ADR-004).
 */
import { chainEvents, type Db } from '@pet-crypto/db';
import type { NormalizedEvent } from '../types.js';

export function toChainEventRow(ev: NormalizedEvent, tokenId: number): typeof chainEvents.$inferInsert {
  return {
    chainId: ev.chainId, txHash: ev.txHash, logIndex: ev.logIndex, eventKind: ev.eventKind,
    tokenId, amountRaw: ev.amountRaw, fromAddr: ev.fromAddr, toAddr: ev.toAddr,
    blockNumber: Number(ev.blockNumber), blockTime: ev.blockTime,
    txFrom: ev.txFrom, txTo: ev.txTo, provider: ev.provider, raw: ev.raw,
  };
}

export async function insertEventRows(db: Db, rows: (typeof chainEvents.$inferInsert)[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(chainEvents)
    .values(rows)
    .onConflictDoNothing({
      target: [chainEvents.chainId, chainEvents.txHash, chainEvents.logIndex, chainEvents.tokenId],
    })
    .returning({ id: chainEvents.id });
  return inserted.length;
}
```

- [ ] **Step 6: Write `checkpoint-repo.ts`**

```ts
/**
 * Checkpoint reads + the transactional page commit (03-ingestion §3): token
 * resolution, event insert, and cursor advance in one Postgres transaction — a
 * crash mid-page re-runs the page for free (idempotency key dedupes).
 */
import type { ChainConfig } from '@pet-crypto/core';
import { chainEvents, ingestionCheckpoints, tokens, type Db } from '@pet-crypto/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { NormalizedEvent } from '../types.js';
import { toChainEventRow } from './event-writer.js';
import { tokenInsertValues, tokenKey } from './token-repo.js';

export interface CheckpointRow {
  chainId: number; address: string; stream: 'native' | 'erc20';
  status: string; lastProcessedBlock: number;
}
export interface CommitTarget { chainId: number; address: string; stream: 'native' | 'erc20'; }

export async function getCheckpoint(
  db: Db, chainId: number, address: string, stream: 'native' | 'erc20',
): Promise<CheckpointRow | undefined> {
  const [row] = await db
    .select({
      chainId: ingestionCheckpoints.chainId, address: ingestionCheckpoints.address,
      stream: ingestionCheckpoints.stream, status: ingestionCheckpoints.status,
      lastProcessedBlock: ingestionCheckpoints.lastProcessedBlock,
    })
    .from(ingestionCheckpoints)
    .where(and(
      eq(ingestionCheckpoints.chainId, chainId),
      eq(ingestionCheckpoints.address, address),
      eq(ingestionCheckpoints.stream, stream),
    ))
    .limit(1);
  return row;
}

export async function seedCheckpoint(
  db: Db, chainId: number, address: string, stream: 'native' | 'erc20',
): Promise<void> {
  await db.insert(ingestionCheckpoints).values({ chainId, address, stream, status: 'queued' }).onConflictDoNothing();
}

export async function commitPage(
  db: Db,
  target: CommitTarget,
  events: NormalizedEvent[],
  next: { lastProcessedBlock: number; status: 'backfilling' | 'live' },
  chain: ChainConfig,
): Promise<number> {
  return db.transaction(async (tx) => {
    const cache = new Map<string, number>();
    const rows: (typeof chainEvents.$inferInsert)[] = [];
    for (const ev of events) {
      const key = tokenKey(ev);
      let tokenId = cache.get(key);
      if (tokenId === undefined) {
        const values = tokenInsertValues(ev, chain);
        await tx.insert(tokens).values(values).onConflictDoNothing({ target: [tokens.chainId, tokens.address] });
        // $inferInsert widens address to string|null|undefined; narrow to
        // string|null so the else-branch is string under exactOptionalPropertyTypes.
        const addr = values.address ?? null;
        const [t] = await tx
          .select({ id: tokens.id })
          .from(tokens)
          .where(addr === null
            ? and(eq(tokens.chainId, ev.chainId), isNull(tokens.address))
            : and(eq(tokens.chainId, ev.chainId), eq(tokens.address, addr)))
          .limit(1);
        if (!t) throw new Error('token upsert failed to resolve id');
        tokenId = t.id;
        cache.set(key, tokenId);
      }
      rows.push(toChainEventRow(ev, tokenId));
    }

    let inserted = 0;
    if (rows.length > 0) {
      const out = await tx
        .insert(chainEvents)
        .values(rows)
        .onConflictDoNothing({
          target: [chainEvents.chainId, chainEvents.txHash, chainEvents.logIndex, chainEvents.tokenId],
        })
        .returning({ id: chainEvents.id });
      inserted = out.length;
    }

    await tx
      .update(ingestionCheckpoints)
      .set({ lastProcessedBlock: next.lastProcessedBlock, status: next.status, updatedAt: new Date() })
      .where(and(
        eq(ingestionCheckpoints.chainId, target.chainId),
        eq(ingestionCheckpoints.address, target.address),
        eq(ingestionCheckpoints.stream, target.stream),
      ));

    return inserted;
  });
}
```

- [ ] **Step 7: Run the integration test — expect PASS**

Run: `pnpm --filter @pet-crypto/ingestion test:integration`
Expected: PASS (all three cases).

- [ ] **Step 8: Build + lint + commit**

```bash
pnpm --filter @pet-crypto/ingestion build && pnpm --filter @pet-crypto/ingestion lint
git add packages/ingestion pnpm-lock.yaml
git commit -m "feat(ingestion): write layer — token upsert, idempotent event insert, transactional cursor"
```

---

### Task 8: Processors — `runBackfillPage`, `runTailTick`, package exports

**Files:**
- Create: `packages/ingestion/src/processors/ingest.ts`, `packages/ingestion/src/processors/backfill.ts`, `packages/ingestion/src/processors/tail.ts`
- Modify: `packages/ingestion/src/index.ts` (export processors, write layer, factory, rpc, logindex, types the worker needs)
- Create: `packages/ingestion/test/processors.itest.ts`

**Interfaces:**
- Consumes: `ProviderBundle` from `provider-factory.js`; `assignErc20Metadata`; `normalize`; `commitPage`/`getCheckpoint`; `chainById`; `Logger`, `Db`.
- Produces: `interface ProcessorDeps { db: Db; bundleFor(chainId: number): ProviderBundle; logger: Logger }`; `interface BackfillTarget { chainId: number; address: string; stream: 'native' | 'erc20' }`; `interface IngestResult { status: 'backfilling' | 'live'; lastProcessedBlock: number; inserted: number; unseenContracts: string[] }`; `runBackfillPage(deps, target): Promise<IngestResult>`; `runTailTick(deps, { chainId }): Promise<void>`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/ingestion/test/processors.itest.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, type Db } from '@pet-crypto/db';
import { createLogger } from '@pet-crypto/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderBundle } from '../src/providers/provider-factory.js';
import type { Page, RawNativeTx, RawReceipt } from '../src/types.js';
import { seedCheckpoint } from '../src/write/checkpoint-repo.js';
import { runBackfillPage } from '../src/processors/backfill.js';

const ADDR = '0xaaa0000000000000000000000000000000000001';
const DEST = '0xbbb0000000000000000000000000000000000002';

const nativeTx = (block: number): RawNativeTx => ({
  blockNumber: String(block), timeStamp: '1700000000', hash: `0xtx${block}`,
  from: ADDR, to: DEST, value: '1000', gasUsed: '21000', gasPrice: '2', isError: '0',
});

// One page of 3 txs, then a short page ⇒ backfill flips to live.
const makeBundle = (): ProviderBundle => ({
  indexer: {
    kind: 'etherscan-v2',
    getHead: async () => 1_000_000n,
    getNativeTxs: async (q): Promise<Page<RawNativeTx>> => {
      const start = Number(q.fromBlock);
      return { items: start <= 100 ? [nativeTx(100), nativeTx(101), nativeTx(102)] : [] };
    },
    getErc20Transfers: async () => ({ items: [] }),
  },
  getReceipts: async (): Promise<RawReceipt[]> => [],
});

describe('runBackfillPage', () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let pool: Pool;
  const deps = () => ({ db, bundleFor: () => makeBundle(), logger: createLogger({ name: 'test' }) });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await runMigrations(pool);
    db = createDb(pool);
  }, 120_000);
  afterAll(async () => { await pool.end(); await container.stop(); });

  const drain = async (): Promise<void> => {
    await seedCheckpoint(db, 1, ADDR, 'native');
    let res = await runBackfillPage(deps(), { chainId: 1, address: ADDR, stream: 'native' });
    while (res.status === 'backfilling') res = await runBackfillPage(deps(), { chainId: 1, address: ADDR, stream: 'native' });
  };

  it('ingests native + gas events and reaches live', async () => {
    await drain();
    const { rows } = await pool.query('SELECT event_kind, count(*)::int AS n FROM chain_events GROUP BY event_kind');
    const byKind = Object.fromEntries(rows.map((r) => [r.event_kind, r.n]));
    expect(byKind.native_transfer).toBe(3);
    expect(byKind.gas_fee).toBe(3);
  });

  it('inv.5 — ingesting the same data twice is byte-identical', async () => {
    const snapshot = async (): Promise<string> =>
      (await pool.query('SELECT tx_hash, log_index, amount_raw FROM chain_events ORDER BY tx_hash, log_index'))
        .rows.map((r) => `${r.tx_hash}:${r.log_index}:${r.amount_raw}`).join('|');
    const first = await snapshot();
    await drain(); // re-run over the same window
    expect(await snapshot()).toBe(first);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @pet-crypto/ingestion test:integration`
Expected: FAIL — `runBackfillPage` module not found.

- [ ] **Step 3: Write `ingest.ts` (shared core)**

```ts
/**
 * One ingestion window for a (chain, address, stream), committed atomically
 * (03-ingestion §3). Never queries past safeHead = head − finalityDepth
 * (ADR-005). Full page ⇒ overlap the boundary block (cursor = last − 1) and stay
 * backfilling; short page ⇒ cursor = safeHead, status live. Receipts feed gas
 * (opstack), erc20 logIndex, and tx-level from/to (spec §6).
 */
import type { Logger } from '@pet-crypto/core';
import { chainById } from '@pet-crypto/core';
import type { Db } from '@pet-crypto/db';
import { assignErc20Metadata } from '../logindex.js';
import { normalize } from '../normalize.js';
import type { ProviderBundle } from '../providers/provider-factory.js';
import type { NormalizedEvent, PageQuery, RawReceipt } from '../types.js';
import { commitPage, getCheckpoint } from '../write/checkpoint-repo.js';

// ProcessorDeps lives here (the shared core) so backfill.ts/tail.ts import it
// from ingest.ts — no ingest ↔ backfill cycle (dependency-cruiser no-circular).
export interface ProcessorDeps { db: Db; bundleFor(chainId: number): ProviderBundle; logger: Logger; }
export interface IngestTarget { chainId: number; address: string; stream: 'native' | 'erc20'; }
export interface IngestResult { status: 'backfilling' | 'live'; lastProcessedBlock: number; inserted: number; unseenContracts: string[]; }

const PAGE_LIMIT = 1000;
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const byHash = (rs: RawReceipt[]): Map<string, RawReceipt> => new Map(rs.map((r) => [r.transactionHash, r]));

export async function ingestOnce(deps: ProcessorDeps, target: IngestTarget): Promise<IngestResult> {
  const chain = chainById(target.chainId);
  const bundle = deps.bundleFor(target.chainId);
  const cp = await getCheckpoint(deps.db, target.chainId, target.address, target.stream);
  if (!cp) throw new Error('no checkpoint for target');

  const head = await bundle.indexer.getHead(target.chainId);
  const safe = head - chain.finalityDepth;
  const fromBlock = BigInt(cp.lastProcessedBlock) + 1n;
  if (fromBlock > safe) {
    await commitPage(deps.db, target, [], { lastProcessedBlock: Number(safe), status: 'live' }, chain);
    return { status: 'live', lastProcessedBlock: Number(safe), inserted: 0, unseenContracts: [] };
  }

  const q: PageQuery = { chainId: target.chainId, address: target.address, fromBlock, toBlock: safe, limit: PAGE_LIMIT, sort: 'asc' };
  let events: NormalizedEvent[];
  let unseenContracts: string[] = [];
  let lastBlock: string | undefined;
  let itemCount: number;

  if (target.stream === 'native') {
    const page = await bundle.indexer.getNativeTxs(q);
    itemCount = page.items.length;
    lastBlock = page.items.at(-1)?.blockNumber;
    let receipts = new Map<string, RawReceipt>();
    if (chain.feeStrategy === 'receipts-opstack') {
      const outHashes = uniq(page.items.filter((t) => t.from.toLowerCase() === target.address).map((t) => t.hash.toLowerCase()));
      receipts = byHash(await bundle.getReceipts(outHashes));
    }
    events = normalize({ native: page }, {
      chainId: target.chainId, trackedAddress: target.address, feeStrategy: chain.feeStrategy,
      provider: bundle.indexer.kind, receipts,
    });
  } else {
    const page = await bundle.indexer.getErc20Transfers(q);
    itemCount = page.items.length;
    lastBlock = page.items.at(-1)?.blockNumber;
    const receipts = byHash(await bundle.getReceipts(uniq(page.items.map((t) => t.hash.toLowerCase()))));
    const enriched = assignErc20Metadata(page.items, receipts);
    events = normalize({ erc20: { items: enriched } }, {
      chainId: target.chainId, trackedAddress: target.address, feeStrategy: chain.feeStrategy, provider: bundle.indexer.kind,
    });
    unseenContracts = uniq(page.items.map((t) => t.contractAddress.toLowerCase()));
  }

  const full = itemCount >= PAGE_LIMIT;
  const newCursor = full && lastBlock !== undefined ? Number(BigInt(lastBlock) - 1n) : Number(safe);
  const status = full ? 'backfilling' : 'live';
  const inserted = await commitPage(deps.db, target, events, { lastProcessedBlock: newCursor, status }, chain);
  return { status, lastProcessedBlock: newCursor, inserted, unseenContracts };
}
```

- [ ] **Step 4: Write `backfill.ts` and `tail.ts`**

`packages/ingestion/src/processors/backfill.ts`:

```ts
import { ingestOnce, type IngestResult, type IngestTarget, type ProcessorDeps } from './ingest.js';

// Re-export so consumers (index.ts, the worker) get ProcessorDeps from either module.
export type { ProcessorDeps, IngestResult } from './ingest.js';
export type BackfillTarget = IngestTarget;

/** One backfill page. The BullMQ host re-enqueues while status === 'backfilling'. */
export function runBackfillPage(deps: ProcessorDeps, target: BackfillTarget): Promise<IngestResult> {
  return ingestOnce(deps, target);
}
```

`packages/ingestion/src/processors/tail.ts`:

```ts
import { eq } from 'drizzle-orm';
import { ingestionCheckpoints } from '@pet-crypto/db';
import { ingestOnce, type ProcessorDeps } from './ingest.js';

/** One tail tick: advance every live stream of a chain up to safeHead. */
export async function runTailTick(deps: ProcessorDeps, t: { chainId: number }): Promise<void> {
  const live = await deps.db
    .select({ address: ingestionCheckpoints.address, stream: ingestionCheckpoints.stream })
    .from(ingestionCheckpoints)
    .where(eq(ingestionCheckpoints.chainId, t.chainId));
  for (const cp of live) {
    // Re-read status per stream inside ingestOnce; tail only polls already-live streams.
    await ingestOnce(deps, { chainId: t.chainId, address: cp.address, stream: cp.stream });
  }
}
```

> `runTailTick` polls every checkpoint of the chain; `ingestOnce`'s `fromBlock > safe` fast-path makes an up-to-date stream a cheap no-op. Filtering to `status = 'live'` is a later optimization; correctness holds because a backfilling stream simply advances one more page.

- [ ] **Step 5: Update `packages/ingestion/src/index.ts`**

Add the public surface the worker imports:

```ts
export { buildProviderBundle, failoverProvider, type ProviderBundle } from './providers/provider-factory.js';
export { httpRpcCall, rpcGetReceipts, type RpcCall } from './providers/rpc.js';
export { assignErc20Metadata, type Erc20WithMeta } from './logindex.js';
export { runBackfillPage, type BackfillTarget, type ProcessorDeps } from './processors/backfill.js';
export { runTailTick } from './processors/tail.js';
export { type IngestResult, type IngestTarget } from './processors/ingest.js';
export { getCheckpoint, seedCheckpoint, commitPage } from './write/checkpoint-repo.js';
export { insertEventRows, toChainEventRow } from './write/event-writer.js';
export { tokenInsertValues } from './write/token-repo.js';
```

- [ ] **Step 6: Run the integration test — expect PASS**

Run: `pnpm --filter @pet-crypto/ingestion test:integration`
Expected: PASS (both cases).

- [ ] **Step 7: Build + hermetic suite + lint + commit**

Run: `pnpm --filter @pet-crypto/ingestion build && pnpm --filter @pet-crypto/ingestion exec vitest run && pnpm --filter @pet-crypto/ingestion lint`
Expected: PASS (hermetic suite unaffected; integration is a separate script).

```bash
git add packages/ingestion
git commit -m "feat(ingestion): backfill + tail processors over the safeHead-guarded checkpoint loop"
```

---

### Task 9: `apps/worker` — BullMQ host, migrate-on-boot, graceful shutdown

**Files:**
- Modify: `apps/worker/package.json` (deps: `bullmq`, `ioredis`, `pg`; devDep `@types/pg`)
- Create: `apps/worker/src/config.ts`, `apps/worker/src/queues.ts`, `apps/worker/src/seed.ts`
- Rewrite: `apps/worker/src/main.ts`
- Create: `apps/worker/test/config.test.ts`

**Interfaces:**
- Consumes: `runMigrations`, `createDb`, `type Db` from `@pet-crypto/db`; `createLogger`, `serializeError`, `chains` from `@pet-crypto/core`; `buildProviderBundle`, `realFetchJson`, `runBackfillPage`, `runTailTick`, `seedCheckpoint`, `type BackfillTarget` from `@pet-crypto/ingestion`.
- Produces (worker-internal): `loadConfig(env?): WorkerConfig`; `TAIL_QUEUE`, `BACKFILL_QUEUE`, `makeConnection(url)`, `backfillJobOptions`, `backoffStrategy`; `seedWallet(db, queue, chainId, address)`.

- [ ] **Step 1: Add dependencies**

In `apps/worker/package.json` add to `dependencies`:

```json
    "bullmq": "^5.34.0",
    "ioredis": "^5.4.0",
    "pg": "^8.22.0"
```

and to `devDependencies`:

```json
    "@types/pg": "^8.20.0"
```

Run `pnpm install`, then confirm the boundary rule still holds (bullmq/ioredis are not signing libs):

Run: `pnpm build && pnpm depcruise`
Expected: PASS — no `no-signing-libraries` violation.

- [ ] **Step 2: Write the failing config test**

Create `apps/worker/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://u@localhost/db', REDIS_URL: 'redis://localhost:6379' };

describe('loadConfig', () => {
  it('accepts the compose-provided env and leaves optional keys undefined', () => {
    const cfg = loadConfig(base);
    expect(cfg.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(cfg.ETHERSCAN_API_KEY).toBeUndefined();
  });

  it('rejects a missing DATABASE_URL loudly', () => {
    expect(() => loadConfig({ REDIS_URL: base.REDIS_URL })).toThrow();
  });
});
```

Run: `pnpm --filter @pet-crypto/worker exec vitest run test/config.test.ts`
Expected: FAIL — module not found. (No `vitest.config.ts` needed — the worker's `test` script is `vitest run --passWithNoTests`; the file runs directly.)

Also update the worker's lint script to cover the new test dir — in `apps/worker/package.json` change `"lint": "eslint src"` to `"lint": "eslint src test"`.

- [ ] **Step 3: Write `config.ts`**

```ts
/**
 * Worker env (ADR-008 / docker-compose). DATABASE_URL and REDIS_URL are injected
 * by compose; ETHERSCAN_API_KEY and BASE_RPC_URL are worker-only provider config.
 */
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  BASE_RPC_URL: z.string().min(1).optional(),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return schema.parse(env);
}
```

Note: `apps/worker/package.json` has no `zod` dep yet — add `"zod": "catalog:"` to `dependencies` and re-run `pnpm install`.

Run: `pnpm --filter @pet-crypto/worker exec vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 4: Write `queues.ts`**

```ts
/**
 * Queue topology (ADR-008 §1-2): tail (high priority, one repeatable tick per
 * chain) beats backfill (low priority, one page window per target). Retry:
 * exponential 1 min → 1 h cap, 8 attempts, then DLQ (removeOnFail: false keeps
 * the failed job for inspection).
 */
import IORedis, { type Redis } from 'ioredis';
import type { JobsOptions } from 'bullmq';

export const TAIL_QUEUE = 'tail';
export const BACKFILL_QUEUE = 'backfill';

// BullMQ requires maxRetriesPerRequest: null on the connection it owns.
export function makeConnection(url: string): Redis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

// Custom backoff so the exponential ramp is capped at 1 h (ADR-008 §2).
export function backoffStrategy(attemptsMade: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attemptsMade - 1), 3_600_000);
}

export const backfillJobOptions: JobsOptions = {
  attempts: 8,
  backoff: { type: 'custom' },
  priority: 10, // lower number = higher priority; tail uses 1
  removeOnComplete: 1000,
  removeOnFail: false,
};

export const tailJobOptions: JobsOptions = {
  attempts: 8,
  backoff: { type: 'custom' },
  priority: 1,
  removeOnComplete: 1000,
  removeOnFail: false,
};
```

- [ ] **Step 5: Write `seed.ts` (dev helper for compose smoke runs)**

```ts
/**
 * Dev-only: register a wallet for ingestion. No ledger_track_wallet MCP tool yet
 * (server slice), so this seeds the queued checkpoints and enqueues the initial
 * backfill for both streams. Used by `docker compose` smoke runs, not in CI.
 */
import { seedCheckpoint, type BackfillTarget } from '@pet-crypto/ingestion';
import type { Db } from '@pet-crypto/db';
import type { Queue } from 'bullmq';
import { backfillJobOptions } from './queues.js';

export async function seedWallet(db: Db, backfillQueue: Queue, chainId: number, address: string): Promise<void> {
  const addr = address.toLowerCase();
  for (const stream of ['native', 'erc20'] as const) {
    await seedCheckpoint(db, chainId, addr, stream);
    const target: BackfillTarget = { chainId, address: addr, stream };
    await backfillQueue.add('page', target, backfillJobOptions);
  }
}
```

- [ ] **Step 6: Rewrite `main.ts`**

```ts
/**
 * Worker host (ADR-008, 00-overview §2). Boot order: load env → migrate → db →
 * redis → queues + workers → repeatable tail per chain. All provider I/O and
 * retries live here; the domain logic runs in @pet-crypto/ingestion. Errors are
 * logged via serializeError — err.cause (hostile) never reaches the log (ADR-011).
 */
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import { chains, createLogger, serializeError } from '@pet-crypto/core';
import { createDb, runMigrations } from '@pet-crypto/db';
import {
  buildProviderBundle, realFetchJson, runBackfillPage, runTailTick, type ProcessorDeps,
} from '@pet-crypto/ingestion';
import { loadConfig } from './config.js';
import {
  BACKFILL_QUEUE, TAIL_QUEUE, backfillJobOptions, backoffStrategy, makeConnection, tailJobOptions,
} from './queues.js';

const logger = createLogger({ name: 'worker' });

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  await runMigrations(pool);
  const db = createDb(pool);
  logger.info('migrations applied');

  const connection = makeConnection(cfg.REDIS_URL);
  const deps: ProcessorDeps = {
    db,
    bundleFor: (chainId) =>
      buildProviderBundle({ chainId, env: process.env, fetchJson: realFetchJson }),
    logger,
  };

  const backfillQueue = new Queue(BACKFILL_QUEUE, { connection });
  const tailQueue = new Queue(TAIL_QUEUE, { connection });

  const backfillWorker = new Worker(
    BACKFILL_QUEUE,
    async (job) => {
      const res = await runBackfillPage(deps, job.data);
      // Full page ⇒ enqueue the next window (ADR-008 §3).
      if (res.status === 'backfilling') await backfillQueue.add('page', job.data, backfillJobOptions);
      return res;
    },
    { connection, concurrency: 5, settings: { backoffStrategy } },
  );

  const tailWorker = new Worker(
    TAIL_QUEUE,
    async (job) => runTailTick(deps, job.data),
    { connection, concurrency: chains.length, settings: { backoffStrategy } },
  );

  for (const w of [backfillWorker, tailWorker]) {
    w.on('failed', (job, err) => { logger.error('job failed', { queue: w.name, jobId: job?.id, err: serializeError(err) }); });
  }

  // Repeatable tail tick per chain (Redis loss recovers on boot — ADR-008).
  for (const chain of chains) {
    await tailQueue.add('tick', { chainId: chain.chainId },
      { ...tailJobOptions, repeat: { every: chain.pollIntervalSec * 1000 }, jobId: `tail-${String(chain.chainId)}` });
  }
  logger.info('worker up', { chains: chains.map((c) => c.chainId) });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await backfillWorker.close();
    await tailWorker.close();
    await backfillQueue.close();
    await tailQueue.close();
    await connection.quit();
    await pool.end();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { void shutdown(signal); });
  }
}

main().catch((err: unknown) => {
  logger.error('worker boot failed', { err: serializeError(err) });
  process.exit(1);
});
```

- [ ] **Step 7: Build + lint + full worker test + commit**

Run: `pnpm --filter @pet-crypto/worker build && pnpm --filter @pet-crypto/worker exec vitest run && pnpm --filter @pet-crypto/worker lint`
Expected: PASS.

```bash
git add apps/worker pnpm-lock.yaml
git commit -m "feat(worker): BullMQ host — migrate on boot, tail+backfill workers, graceful shutdown"
```

- [ ] **Step 8: Smoke-validate the host over compose**

Copy `.env.example` → `.env` (set `POSTGRES_PASSWORD`), then:

```bash
docker compose up -d postgres redis
docker compose up worker   # observe: JSON logs "migrations applied" → "worker up"
```

Confirm in the logs: migrations run once, `worker up` lists chains `[1, 8453]`, no crash. Stop with Ctrl-C and confirm a clean `shutting down` line (no `err.cause`, no stack). Tear down: `docker compose down`.

> If a wallet is available, `seedWallet` can be invoked from a throwaway `tsx` script against the compose DB/Redis to watch a real backfill land rows — optional, not required for this task's gate.

---

### Task 10: Capture extension, doc reconcile, CI integration job, final verification

**Files:**
- Modify: `packages/ingestion/scripts/capture.ts` (record receipts-with-logs for erc20 txs)
- Modify: `docs/architecture/03-ingestion.md` (§1 anchoring deferred note)
- Modify: `.github/workflows/ci.yml` (add `integration` job)

**Interfaces:**
- Consumes: existing capture machinery (`recordingTransport`, adapters, `upsertManifest`); `buildProviderBundle` / `httpRpcCall` for Base receipts.
- Produces: receipt-with-logs fixtures under `packages/evals/fixtures/providers/**`; a green `integration` CI job.

- [ ] **Step 1: Reconcile the state-machine doc**

In `docs/architecture/03-ingestion.md` §1, add below the mermaid block:

```markdown
> **`anchoring` is deferred** (worker-ingestion slice, 2026-07-18): the current
> ingester does full-history backfill only, and `ingestion_checkpoints.status`
> has no `anchoring` value (see `schema.sql`). The `queued → anchoring` and
> `anchoring → backfilling` transitions and the anchored-window / `opening_balance`
> path land with the anchored-backfill slice; until then a wallet goes
> `queued → backfilling` regardless of size.
```

Commit:

```bash
git add docs/architecture/03-ingestion.md
git commit -m "docs(ingestion): mark anchoring state deferred to match the checkpoint DDL"
```

- [ ] **Step 2: Extend the capture script for receipts-with-logs**

In `packages/ingestion/scripts/capture.ts`, after the erc20 pages are walked for a wallet, collect the distinct tx hashes from the captured `tokentx` rows and fetch a receipt per hash so the fixtures carry `logs`:
- **Ethereum (chain 1):** drive the etherscan adapter's `getReceipts` through the same `recordingTransport` (records `module=proxy&action=eth_getTransactionReceipt` responses, which include `logs`).
- **Base (chain 8453):** the indexer APIs don't serve receipts — use `httpRpcCall(env.BASE_RPC_URL)` + `rpcGetReceipts`, and record each JSON-RPC response to a fixture file keyed like the other Base receipt fixtures (reuse the capture file-naming; the RPC body is POST, so store it under an `rpc/8453/` subtree with a hash of `method+params`).
- Cap receipts at the same 40-distinct-tx bound the capture already applies to token-meta/balance calls (spam wallets), and throttle ≥ 250 ms between etherscan calls.
- Update `manifest.json` with a `receipts` count per wallet/chain via `upsertManifest`.

This step runs live (dev only, never CI): `pnpm --filter @pet-crypto/ingestion capture -- --wallet 0x… --role freelancer --chains 1,8453`. It requires `ETHERSCAN_API_KEY` and, for Base, `BASE_RPC_URL` in `.env`. Wallets are the already-captured golden set (`freelancer`, `smb-stables`, `edge-spam`).

> Sequencing note: this is the one non-hermetic step. Land it after the code tasks so the erc20 end-to-end golden (Step 3) has real fixtures. If the capture is deferred (no network), the slice still ships — the erc20 logIndex logic is fully unit-tested (Task 5/6) and the write path is integration-tested with synthetic receipts (Task 7/8); only the *real-fixture* erc20 golden waits.

- [ ] **Step 3: Add the erc20 end-to-end golden (after capture)**

Once receipt fixtures exist, add a case to `packages/ingestion/test/processors.itest.ts` that drives `runBackfillPage` for the `erc20` stream of a golden wallet via a `FixtureTransport`-backed bundle (native/erc20 pages) plus a fixture-backed receipt source, and asserts the resulting `chain_events` erc20 rows have real `logIndex` values and correct `tx_from`/`tx_to`. Assert per-token `amount_raw` sums (reviewable numbers, not snapshots).

Commit:

```bash
git add packages/ingestion packages/evals/fixtures
git commit -m "test(ingestion): erc20 end-to-end golden over captured receipt fixtures"
```

- [ ] **Step 4: Add the CI `integration` job**

In `.github/workflows/ci.yml`, add a job (Docker is available on `ubuntu-latest`, which testcontainers uses):

```yaml
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm --filter @pet-crypto/db test:integration
      - run: pnpm --filter @pet-crypto/ingestion test:integration
```

(Match the existing jobs' exact `uses`/version pins and pnpm setup from the `check`/`test` jobs.)

Commit:

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run db + ingestion testcontainers integration suites"
```

- [ ] **Step 5: Full-repo verification**

Run the whole gate from the repo root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm depcruise                       # boundaries + no-signing-libraries
pnpm test                            # hermetic unit/golden suites, all packages
pnpm --filter @pet-crypto/db test:integration
pnpm --filter @pet-crypto/ingestion test:integration
bash scripts/check-schema-parity.sh  # unchanged DDL still matches schema.sql
```

Expected: all green. `depcruise` proves `packages/ingestion` still imports only `db`/`core` and no signing lib entered the tree; schema-parity proves no DDL drift.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/worker-ingestion
gh pr create --title "feat(worker): BullMQ ingestion host + checkpoint SM + idempotent chain_events" \
  --body "Implements docs/superpowers/specs/2026-07-18-worker-ingestion-design.md. Tail+backfill only; anchored/token-resolve/integrity/prices deferred. See plan docs/superpowers/plans/2026-07-18-worker-ingestion.md."
```

---

## Coverage map (spec → task)

| Spec item | Task |
|---|---|
| logger + serializeError (drops cause) | 1 |
| chains.config `rpcUrlEnv` | 1 |
| programmatic `runMigrations` | 2 |
| `RawLog` / `RawReceipt` logs+from+to | 3 |
| RPC receipt path + provider factory failover | 4 |
| receipt-derived erc20 `logIndex` + tx from/to | 5 |
| `normalize()` tx-level fields + erc20 enrichment + `raw` | 6 |
| write layer (token upsert, idempotent insert, txn cursor) | 7 |
| backfill/tail processors, safeHead guard, inv.5/inv.6 property tests | 7 (inv.6), 8 (inv.5) |
| BullMQ host, migrate-on-boot, retry/backoff, shutdown | 9 |
| capture receipts-with-logs, doc reconcile, CI integration, erc20 golden | 10 |

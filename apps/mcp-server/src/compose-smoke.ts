/**
 * E2E compose smoke — the pre-release layer of the test pyramid (04-testing.md §1):
 * "docker compose up, connect a stdio MCP client, make three tool calls, assert the
 * envelope." The layers below (unit / property / contract / testcontainers-integration)
 * run per-commit but none exercises the *actual* self-host artifacts. This one does:
 * the real docker-compose.yml, the Dockerfile image, and the stdio entrypoint wired
 * together — proof the P10 self-host story boots. Manual / pre-release cadence; no API
 * key, no network beyond pulling base images.
 *
 * Lives in src/ (like keygen.ts) so `tsc -b` typechecks it and `eslint src` lints it —
 * run via tsx (`pnpm smoke:compose`), never imported by the server.
 *
 * Flow:
 *   1. `docker compose up -d --build` — postgres, redis, mcp-server(http), worker. The
 *      worker migrates on boot (runMigrations, worker/main.ts) — the real stack's migrator.
 *   2. Wait for the schema: poll `to_regclass('public.tenants')` via `compose exec psql`
 *      (local socket, trust auth — no password) until non-null. Deterministic, no log scrape.
 *   3. Connect an MCP Client over stdio, launching the documented one-off invocation
 *      `docker compose run --rm -T mcp-server node apps/mcp-server/dist/stdio.js`.
 *   4. listTools() === 19; then a write→read round-trip + a recon read, asserting each
 *      envelope (C1 provenance, §2 schema) via the pure smoke-assert helper.
 *   5. `docker compose down -v` always (finally); non-zero exit on any failure.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { assertEnvelope } from './smoke-assert.js';

/** Registry size (packages/mcp-tools/src/index.ts `tools`). A drift here is a real regression. */
const EXPECTED_TOOL_COUNT = 19;
/** Any valid EVM address; the schema lowercases it. Fresh DB ⇒ this is the only wallet. */
const FIXTURE_ADDRESS = '0x000000000000000000000000000000000000dead';
const SCHEMA_TIMEOUT_MS = 120_000;
/**
 * Dedicated compose project — NOT the `name: reconcil` in docker-compose.yml. Its own
 * containers/network/volumes, so the final `down -v` can never touch a real self-host
 * stack's data. (`-p` overrides the file's project name.)
 */
const PROJECT = 'reconcil-smoke';

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/mcp-server/src (or dist at runtime)
const ROOT = path.resolve(here, '..', '..', '..'); // repo root (docker-compose.yml lives here)

/**
 * `docker compose -f base -f smoke-override -p reconcil-smoke <extra…>` — every compose
 * call shares the project and layers the smoke override (docker-compose.smoke.yml, which
 * drops published host ports so the smoke can't collide with anything on 5432/8484).
 */
const compose = (...extra: string[]): string[] =>
  ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.smoke.yml', '-p', PROJECT, ...extra];

interface ShResult { code: number; stdout: string; stderr: string }

/** Spawn `cmd args` in ROOT. `capture` pipes stdout/stderr; otherwise inherits the terminal. */
function sh(cmd: string, args: string[], capture = false): Promise<ShResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

async function shOrThrow(cmd: string, args: string[]): Promise<void> {
  const { code } = await sh(cmd, args);
  if (code !== 0) throw new Error(`\`${cmd} ${args.join(' ')}\` exited ${String(code)}`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the compose Postgres for the migrated schema (the worker migrates on boot). */
async function waitForSchema(): Promise<void> {
  const deadline = Date.now() + SCHEMA_TIMEOUT_MS;
  const psql = compose('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'reconcil', '-tAc', "select to_regclass('public.tenants')");
  while (Date.now() < deadline) {
    const { code, stdout } = await sh('docker', psql, true);
    if (code === 0 && stdout.trim() === 'tenants') return;
    await delay(2000);
  }
  throw new Error('timed out waiting for migrations — public.tenants never appeared (is the worker healthy?)');
}

/** process.env with undefined values dropped (the SDK transport wants Record<string,string>). */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

async function callTools(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'docker',
    args: compose('run', '--rm', '-T', 'mcp-server', 'node', 'apps/mcp-server/dist/stdio.js'),
    cwd: ROOT,
    env: cleanEnv(),
    stderr: 'inherit', // surface the stdio server's stderr logs for debugging
  });
  const client = new Client({ name: 'compose-smoke', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    if (tools.length !== EXPECTED_TOOL_COUNT) {
      throw new Error(`listTools: expected ${String(EXPECTED_TOOL_COUNT)} tools, got ${String(tools.length)}`);
    }
    console.log(`  ✓ listTools → ${String(tools.length)} tools`);

    // 1 (write): onboard a wallet.
    assertEnvelope('ledger_track_wallet', await client.callTool({
      name: 'ledger_track_wallet', arguments: { address: FIXTURE_ADDRESS },
    }));
    console.log('  ✓ ledger_track_wallet → envelope with provenance');

    // 2 (read): the write must round-trip through the real image (empty DB before ⇒ exactly ours).
    const statusEnv = assertEnvelope('ledger_status', await client.callTool({ name: 'ledger_status', arguments: {} }));
    const wallets = statusEnv.data['wallets'];
    if (!Array.isArray(wallets) || wallets.length < 1) {
      throw new Error('ledger_status: tracked wallet did not round-trip (data.wallets empty)');
    }
    console.log('  ✓ ledger_status → tracked wallet present (write→persist→read, C2)');

    // 3 (read): a Face B snapshot over the fresh tenant.
    assertEnvelope('recon_status', await client.callTool({ name: 'recon_status', arguments: {} }));
    console.log('  ✓ recon_status → valid envelope');
  } finally {
    await client.close().catch(() => { /* transport already tearing down */ });
  }
}

async function main(): Promise<void> {
  if (!existsSync(path.join(ROOT, '.env'))) {
    throw new Error('.env is missing at repo root — copy .env.example to .env (compose needs POSTGRES_PASSWORD)');
  }

  try {
    console.log(`› docker compose -p ${PROJECT} up -d --build …`);
    await shOrThrow('docker', compose('up', '-d', '--build'));
    console.log('› waiting for migrations …');
    await waitForSchema();
    console.log('› stdio client — listTools + 3 tool calls …');
    await callTools();
    console.log('\n✅ compose smoke passed — self-host stack boots and serves valid envelopes.');
  } finally {
    // Always tear down — even a partial `up` (a mid-boot failure) leaves containers/volumes.
    console.log(`\n› docker compose -p ${PROJECT} down -v …`);
    await sh('docker', compose('down', '-v'));
  }
}

main().catch((err: unknown) => {
  console.error(`\n❌ compose smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

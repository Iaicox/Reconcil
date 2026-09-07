/**
 * HTTP transport seam for price providers — a pricing-local copy of the
 * ingestion harness (pricing and ingestion are sibling packages, so neither may
 * import the other; core forbids network/fs I/O, so the I/O functions themselves
 * can't live there). Same three modes: real fetch, fixture replay (tests),
 * recording (capture). Keeps capture and replay on one canonical URL form so
 * recorded fixtures match. The redacted-param list has no I/O, so it's a shared
 * `@reconcil/core` constant instead of a second copy that can drift from
 * ingestion's (`SECRET_QUERY_PARAMS`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SECRET_QUERY_PARAMS } from '@reconcil/core';

/** Deliberately dumb: no retries, no throttling (the worker wraps it). */
export type FetchJson = (url: string) => Promise<{ status: number; body: unknown }>;

/** One canonical URL form shared by capture (record) and tests (replay). */
export function canonicalizeUrl(url: string): string {
  const u = new URL(url);
  for (const p of SECRET_QUERY_PARAMS) if (u.searchParams.has(p)) u.searchParams.set(p, 'REDACTED');
  u.searchParams.sort();
  return u.toString();
}

export function fixtureFileName(url: string): string {
  const canonical = canonicalizeUrl(url);
  const u = new URL(canonical);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  const last = u.pathname.split('/').filter(Boolean).at(-1) ?? 'request';
  const host = u.hostname.split('.').at(-2) ?? u.hostname;
  return `${host}_${last}_${hash}.json`;
}

interface FixtureFile {
  request: { url: string };
  response: { status: number; body: unknown };
}

/** Replay: url → canonical key → file. A missing file throws — tests fail loudly. */
export function fixtureTransport(dir: string): FetchJson {
  return (url) => {
    const file = join(dir, fixtureFileName(url));
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return Promise.reject(new Error(`fixture missing for ${canonicalizeUrl(url)} (expected ${file})`));
    }
    const parsed = JSON.parse(text) as FixtureFile;
    return Promise.resolve(parsed.response);
  };
}

/** Capture: wrap a real transport, persist every (url, response) pair. */
export function recordingTransport(inner: FetchJson, dir: string): FetchJson {
  mkdirSync(dir, { recursive: true });
  return async (url) => {
    const response = await inner(url);
    const fixture: FixtureFile = { request: { url: canonicalizeUrl(url) }, response };
    writeFileSync(join(dir, fixtureFileName(url)), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    return response;
  };
}

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Space requests by ≥ `ms` — public price endpoints (DefiLlama/CoinGecko/ECB) rate-limit
 * bursts. NOTE: duplicated (not shared) at packages/ingestion/scripts/capture.ts — domain
 * packages may not import each other's internals (dependency-cruiser
 * `domain-depends-only-on-db-core`), and this is a script, not a package export. Keep the
 * two copies in sync.
 */
export function throttled(inner: FetchJson, ms: number): FetchJson {
  let last = 0;
  // Concurrent callers must be serialized through ONE queue. The bug this replaces:
  // `wait` was computed synchronously from `last`, so N calls dispatched in the same
  // tick all read the same `last`, compute the same wait, sleep the same amount, then
  // fire together — the rate limit is bypassed exactly when it matters (a burst).
  // Chaining each call's wait-and-claim step onto the previous one serializes the
  // critical section (read `last` → wait out the remainder → stamp `last`) without
  // forcing the underlying `inner(url)` calls themselves to run one-at-a-time — a
  // request can still be in flight while the next call's spacing is being enforced.
  let queue: Promise<void> = Promise.resolve();
  return (url) => {
    const turn = queue.then(async () => {
      const wait = last + ms - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
    });
    // Advance the queue unconditionally so one rejected link can't wedge every caller
    // behind it forever (the wait step itself can't throw, but stay defensive).
    queue = turn.catch(() => undefined);
    return turn.then(() => inner(url));
  };
}

/** Production transport over global fetch (Node ≥ 22). Non-JSON bodies pass through as text. */
export function realFetchJson(): FetchJson {
  return async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
}

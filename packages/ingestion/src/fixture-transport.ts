import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchJson } from './types.js';

/** One canonical URL form shared by capture (record) and tests (replay). */
export function canonicalizeUrl(url: string): string {
  const u = new URL(url);
  if (u.searchParams.has('apikey')) u.searchParams.set('apikey', 'REDACTED');
  u.searchParams.sort();
  return u.toString();
}

export function fixtureFileName(url: string): string {
  const canonical = canonicalizeUrl(url);
  const u = new URL(canonical);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  const action =
    u.searchParams.get('action') ?? u.pathname.split('/').filter(Boolean).at(-1) ?? 'request';
  const addr = u.searchParams.get('address') ?? u.searchParams.get('contractaddress');
  const addr8 = addr ? addr.toLowerCase().replace(/^0x/, '').slice(0, 8) : null;
  return addr8 ? `${action}_${addr8}_${hash}.json` : `${action}_${hash}.json`;
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
      return Promise.reject(
        new Error(`fixture missing for ${canonicalizeUrl(url)} (expected ${file})`),
      );
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

/** Production transport over global fetch (Node ≥ 22). Non-JSON bodies pass through as text. */
export function realFetchJson(): FetchJson {
  return async (url) => {
    const res = await fetch(url);
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

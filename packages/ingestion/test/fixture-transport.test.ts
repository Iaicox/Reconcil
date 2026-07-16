import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  fixtureFileName,
  fixtureTransport,
  recordingTransport,
} from '../src/fixture-transport.js';
import type { FetchJson } from '../src/types.js';

const URL_A =
  'https://api.etherscan.io/v2/api?module=account&action=txlist&address=0xAbC1230000000000000000000000000000000000&startblock=0&endblock=100&page=1&offset=1000&sort=asc&apikey=SECRET123&chainid=1';

describe('canonicalizeUrl', () => {
  it('sorts query params and redacts apikey', () => {
    const c = canonicalizeUrl(URL_A);
    expect(c).not.toContain('SECRET123');
    expect(c).toContain('apikey=REDACTED');
    const keys = [...new URL(c).searchParams.keys()];
    expect(keys).toEqual([...keys].sort());
  });

  it('is stable regardless of original param order', () => {
    const shuffled =
      'https://api.etherscan.io/v2/api?apikey=SECRET123&chainid=1&sort=asc&offset=1000&page=1&endblock=100&startblock=0&address=0xAbC1230000000000000000000000000000000000&action=txlist&module=account';
    expect(canonicalizeUrl(shuffled)).toBe(canonicalizeUrl(URL_A));
  });
});

describe('fixtureFileName', () => {
  it('is action_addr8_hash8.json for address requests', () => {
    expect(fixtureFileName(URL_A)).toMatch(/^txlist_abc12300_[0-9a-f]{8}\.json$/);
  });

  it('is action_hash8.json when no address param', () => {
    const url = 'https://api.etherscan.io/v2/api?module=proxy&action=eth_blockNumber&chainid=1&apikey=K';
    expect(fixtureFileName(url)).toMatch(/^eth_blockNumber_[0-9a-f]{8}\.json$/);
  });
});

describe('recording → fixture round-trip', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('replays exactly what was recorded, with the key scrubbed on disk', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fixtures-'));
    const inner: FetchJson = () =>
      Promise.resolve({ status: 200, body: { status: '1', message: 'OK', result: [{ x: 1 }] } });

    const recorded = await recordingTransport(inner, dir)(URL_A);
    const replayed = await fixtureTransport(dir)(URL_A);

    expect(replayed).toEqual(recorded);
    // key variant of the same request (different apikey) resolves to the same file
    const otherKey = URL_A.replace('SECRET123', 'OTHERKEY');
    await expect(fixtureTransport(dir)(otherKey)).resolves.toEqual(recorded);
  });

  it('throws loudly on a missing fixture', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fixtures-'));
    await expect(fixtureTransport(dir)(URL_A)).rejects.toThrow(/fixture missing/i);
  });
});

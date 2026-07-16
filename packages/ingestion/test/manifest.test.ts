import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertScrubbed, readManifest, upsertManifest } from '../src/manifest.js';
import type { WalletManifestEntry } from '../src/manifest.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(overrides: Partial<WalletManifestEntry>): WalletManifestEntry {
  return {
    address: '0xabc',
    role: 'freelancer',
    capturedAt: '2026-07-16T00:00:00.000Z',
    chains: { '1': { fromBlock: '0', toBlock: '100', counts: { 'etherscan-v2': { native: 3, erc20: 5 } } } },
    ...overrides,
  };
}

describe('manifest', () => {
  it('creates then upserts by address', () => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-'));
    const path = join(dir, 'manifest.json');
    upsertManifest(path, entry({}));
    upsertManifest(path, entry({ role: 'edge-spam' }));
    upsertManifest(path, entry({ address: '0xdef' }));
    const entries = readManifest(path);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.address === '0xabc')?.role).toBe('edge-spam');
  });
});

describe('assertScrubbed', () => {
  it('passes on clean trees and throws when the secret leaks', () => {
    dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'ok.json'), '{"apikey":"REDACTED"}');
    expect(() => assertScrubbed(dir, 'SECRET123')).not.toThrow();
    writeFileSync(join(dir, 'sub', 'leak.json'), '{"url":"...apikey=SECRET123"}');
    expect(() => assertScrubbed(dir, 'SECRET123')).toThrow(/leak\.json/);
  });
});

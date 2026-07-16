import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WalletManifestEntry {
  address: string;
  role: string;
  capturedAt: string;
  /** keyed by chainId; counts keyed by provider kind */
  chains: Record<
    string,
    {
      fromBlock: string;
      toBlock: string;
      counts: Record<string, { native: number; erc20: number }>;
    }
  >;
}

export function readManifest(path: string): WalletManifestEntry[] {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WalletManifestEntry[];
  } catch {
    return [];
  }
}

export function upsertManifest(path: string, entry: WalletManifestEntry): void {
  const entries = readManifest(path).filter((e) => e.address !== entry.address);
  entries.push(entry);
  entries.sort((a, b) => a.address.localeCompare(b.address));
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

/** Belt-and-suspenders: no written fixture may contain the API key. */
export function assertScrubbed(rootDir: string, secret: string): void {
  for (const dirent of readdirSync(rootDir, { withFileTypes: true, recursive: true })) {
    if (!dirent.isFile()) continue;
    const path = join(dirent.parentPath, dirent.name);
    if (readFileSync(path, 'utf8').includes(secret)) {
      throw new Error(`API key leaked into fixture: ${path}`);
    }
  }
}

/**
 * Own the temp export-dir lifecycle for `evals run` (a Face B journal-draft case's
 * `export_journal_drafts` writes real files, routed away from cwd/exports). Extracted from
 * run.ts (a script entrypoint that runs on import) so the create/cleanup pairing is
 * unit-testable without spinning a container.
 *
 * The dir is created INSIDE the try this function owns, so any failure before that point
 * (or the mkdtemp call itself failing) leaves nothing to clean up — the finally checks the
 * "never created" case and no-ops rather than throwing on a nonexistent path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Create a temp dir under `tmpRoot`, run `fn(dir)`, and always remove the dir afterward —
 *  even if `fn` throws (e.g. DB provisioning fails) before writing anything into it. */
export async function withTempExportDir<T>(tmpRoot: string, fn: (dir: string) => Promise<T>): Promise<T> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpRoot, 'reconcil-evals-exports-'));
    return await fn(dir);
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

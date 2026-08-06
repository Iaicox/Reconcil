import { describe, expect, it } from 'vitest';

describe('stdio entrypoint guard (H13/H14 slice minors)', () => {
  it('importing the module does not boot a server (side-effect-free like http.ts/keygen.ts)', async () => {
    // Under vitest, process.argv[1] is the test runner's own path, never this
    // file's — so main()'s guard (`import.meta.url === pathToFileURL(process.argv[1]).href`)
    // is always false on import. The module-scope stderr-logger construction is
    // the only side effect. Pre-fix, `main()` ran unconditionally at module scope:
    // this import would call loadConfig() (throws without DATABASE_URL) or open a
    // real pg Pool and hang — this test would fail or time out instead of
    // resolving quickly.
    const mod = await import('../src/stdio.js');
    expect(mod).toBeDefined();
  });

  // Shutdown ordering (idempotent flag → server.close() [cascades to the
  // transport, Protocol.close()] → pool.end() → forced-exit timer) mirrors
  // apps/worker/src/main.ts's already-covered pattern verbatim. Exercising it
  // here would need a live `server` + `pool` and real signal delivery — a
  // testcontainers itest or heavy Server/Pool mocking, a heavier harness than
  // this transport-parity slice warrants. Left unverified beyond code review
  // against the worker's pattern, per the brief's "skip with a comment" allowance.
  it.skip('shutdown ordering — not unit-tested, see comment above', () => {});
});

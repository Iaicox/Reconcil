#!/usr/bin/env node
/**
 * Unit coverage for the two lockfile parsers in check-no-signing-libs.cjs — this IS the
 * ADR-011 transitive-import enforcement (dependency-cruiser's rule of the same name only
 * catches direct workspace imports), so a parsing blind spot here is a real evasion path,
 * not a lint nicety. Uses node:test + node:assert only — scripts/ isn't a workspace
 * package (no package.json, no vitest wiring via turbo), and this is deliberately not
 * given one: a fixture-driven test over two pure functions doesn't earn a new test
 * harness. Run directly: `node --test scripts/check-no-signing-libs.test.cjs`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  banned,
  findOffendersInPnpmLock,
  findOffendersInNpmLock,
  splitNameAtSpec,
} = require('./check-no-signing-libs.cjs');

// Sanity: the banned regex is derived from the real .dependency-cruiser.cjs denylist, so
// these fixtures exercise it against names that are actually on the list today.
test('banned regex sanity — known members', () => {
  assert.ok(banned.test('ox'));
  assert.ok(banned.test('starknet'));
  assert.ok(banned.test('bitcoinjs-lib'));
  assert.ok(!banned.test('oxlint')); // prefix, not the package itself
  assert.ok(!banned.test('left-pad'));
});

test('splitNameAtSpec — unscoped, scoped, peer-qualified, no-spec, alias-target shapes', () => {
  assert.deepEqual(splitNameAtSpec('abort-controller@3.0.0'), {
    name: 'abort-controller',
    spec: '3.0.0',
  });
  assert.deepEqual(splitNameAtSpec('@anthropic-ai/sdk@0.114.0(zod@4.4.3)'), {
    name: '@anthropic-ai/sdk',
    spec: '0.114.0(zod@4.4.3)',
  });
  assert.equal(splitNameAtSpec('@reconcil/ingestion'), null); // bare scoped name, no spec
  assert.equal(splitNameAtSpec('dependency-cruiser'), null); // bare unscoped name, no spec
  assert.deepEqual(splitNameAtSpec('my-alias@npm:@noble/hashes@1.2.3'), {
    name: 'my-alias',
    spec: 'npm:@noble/hashes@1.2.3',
  });
});

test('findOffendersInPnpmLock — plain semver entries (baseline)', () => {
  const lock = [
    "packages:",
    "",
    "  ox@1.0.0:",
    "    resolution: {integrity: sha512-x==}",
    "",
    "  left-pad@1.3.0:",
    "    resolution: {integrity: sha512-y==}",
    "",
  ].join('\n');
  assert.deepEqual([...findOffendersInPnpmLock(lock)], ['ox']);
});

test('findOffendersInPnpmLock — git/URL/file specs (non-digit version, previously invisible)', () => {
  const lock = [
    "packages:",
    "",
    "  bitcoinjs-lib@github:bitcoinjs/bitcoinjs-lib#abc123:",
    "    resolution: {tarball: git+https://github.com/bitcoinjs/bitcoinjs-lib.git}",
    "",
    "  starknet@https://example.com/starknet.tgz:",
    "    resolution: {integrity: sha512-z==}",
    "",
    "  left-pad@file:../vendor/left-pad:",
    "    resolution: {integrity: sha512-w==}",
    "",
  ].join('\n');
  const offenders = [...findOffendersInPnpmLock(lock)].sort();
  assert.deepEqual(offenders, ['bitcoinjs-lib', 'starknet']);
});

test('findOffendersInPnpmLock — npm: alias spec flags the ALIAS TARGET, not the local key', () => {
  const lock = [
    "packages:",
    "",
    "  totally-innocent-name@npm:ox@2.0.0:",
    "    resolution: {integrity: sha512-a==}",
    "",
  ].join('\n');
  assert.deepEqual([...findOffendersInPnpmLock(lock)], ['ox']);
});

test('findOffendersInPnpmLock — scoped npm: alias target', () => {
  const lock = [
    "packages:",
    "",
    "  my-alias@npm:@noble/hashes@1.2.3:",
    "    resolution: {integrity: sha512-b==}",
    "",
  ].join('\n');
  assert.deepEqual([...findOffendersInPnpmLock(lock)], ['@noble/hashes']);
});

test('findOffendersInPnpmLock — nested dependency-list value lines are not mistaken for package keys', () => {
  const lock = [
    "packages:",
    "",
    "  '@anthropic-ai/sdk@0.114.0(zod@4.4.3)':",
    "    dependencies:",
    "      json-schema-to-ts: 3.1.1",
    "    optionalDependencies:",
    "      zod: 4.4.3",
    "",
    "  '@reconcil/ingestion':", // importers-style bare name, no spec
    "    specifier: workspace:*",
    "    version: link:packages/ingestion",
    "",
  ].join('\n');
  assert.deepEqual([...findOffendersInPnpmLock(lock)], []);
});

test('findOffendersInNpmLock — key-derived name (baseline)', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'reconcil-site' },
      'node_modules/ox': { version: '2.0.0' },
      'node_modules/left-pad': { version: '1.3.0' },
    },
  });
  assert.deepEqual([...findOffendersInNpmLock(lock)], ['ox']);
});

test('findOffendersInNpmLock — nested transitive key (name after LAST node_modules/)', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'reconcil-site' },
      'node_modules/some-parent/node_modules/bitcoinjs-lib': { version: '6.1.0' },
    },
  });
  assert.deepEqual([...findOffendersInNpmLock(lock)], ['bitcoinjs-lib']);
});

test('findOffendersInNpmLock — aliased install: banned name hidden behind a harmless key', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'reconcil-site' },
      'node_modules/harmless': { name: '@noble/hashes', version: '1.2.3' },
    },
  });
  assert.deepEqual([...findOffendersInNpmLock(lock)], ['@noble/hashes']);
});

test('findOffendersInNpmLock — lockfileVersion 1 (no "packages" map) fails loud, not clean', () => {
  const lock = JSON.stringify({
    lockfileVersion: 1,
    dependencies: { ox: { version: '2.0.0' } },
  });
  assert.throws(() => findOffendersInNpmLock(lock), /no "packages" map/);
});

test('findOffendersInNpmLock — missing/malformed packages key fails loud', () => {
  assert.throws(() => findOffendersInNpmLock(JSON.stringify({ lockfileVersion: 3 })), /no "packages" map/);
});

// ── Exit codes ──────────────────────────────────────────────────────────────
// The guard's two failure modes are different jobs for whoever reads the CI log: 1 means
// "remove this dependency", 2 means "the guard could not see everything". They used to be
// conflated — a violation found in the first lockfile, followed by an unreadable second
// one, exited 2 and reported "cannot run" over a banned package it had already printed.
// Driven as a subprocess because the codes are process-level, and against a temp repo
// layout so the real lockfiles are never the thing under test.

const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

// Same `packages:` map shape the parser tests above use — a package KEY per entry, not a
// dependency list (the parser deliberately distinguishes the two).
const CLEAN_PNPM = `packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-y==}
`;
const DIRTY_PNPM = `packages:

  ox@1.0.0:
    resolution: {integrity: sha512-x==}
`;
const CLEAN_NPM = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'site' } } });

/** Lay out a throwaway repo root that the guard's relative paths resolve against. */
function stage({ pnpmLock, npmLock }) {
  const root = mkdtempSync(join(tmpdir(), 'adr011-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'site'));
  copyFileSync(join(__dirname, 'check-no-signing-libs.cjs'), join(root, 'scripts', 'check-no-signing-libs.cjs'));
  // The guard reads its banned list from the cruiser config one level up — copy it too, or
  // the staged run dies on MODULE_NOT_FOUND before it can reach any exit code.
  copyFileSync(join(__dirname, '..', '.dependency-cruiser.cjs'), join(root, '.dependency-cruiser.cjs'));
  if (pnpmLock !== null) writeFileSync(join(root, 'pnpm-lock.yaml'), pnpmLock);
  if (npmLock !== null) writeFileSync(join(root, 'site', 'package-lock.json'), npmLock);
  return root;
}

/** Run the staged guard; returns { code, stderr }. */
function run(root) {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'check-no-signing-libs.cjs')], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (err) {
    return { code: err.status, stderr: String(err.stderr ?? '') };
  }
}

test('exit 0 when both lockfiles are clean', () => {
  const root = stage({ pnpmLock: CLEAN_PNPM, npmLock: CLEAN_NPM });
  try {
    assert.equal(run(root).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exit 1 — the guard ran and found a violation', () => {
  const root = stage({ pnpmLock: DIRTY_PNPM, npmLock: CLEAN_NPM });
  try {
    const { code, stderr } = run(root);
    assert.equal(code, 1);
    assert.match(stderr, /ADR-011 violation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exit 2 — the guard could not run (missing lockfile), nothing else wrong', () => {
  const root = stage({ pnpmLock: CLEAN_PNPM, npmLock: null });
  try {
    const { code, stderr } = run(root);
    assert.equal(code, 2);
    assert.match(stderr, /cannot run/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a violation outranks an unreadable second lockfile — exit 1, and says the scan was partial', () => {
  // This is the conflation the split exists to remove: pre-fix this exited 2, reporting
  // "cannot run" over a banned package it had already printed one line earlier.
  const root = stage({ pnpmLock: DIRTY_PNPM, npmLock: null });
  try {
    const { code, stderr } = run(root);
    assert.equal(code, 1);
    assert.match(stderr, /ADR-011 violation/);
    assert.match(stderr, /may be incomplete/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Only findOffendersInNpmLock can THROW (JSON.parse, plus its lockfileVersion-shape guard);
// findOffendersInPnpmLock is a line scanner that returns an empty set for any garbage. So the
// parse-failure branch of main() is reachable only through the SECOND lockfile, and "an
// unparseable FIRST lockfile" is not a state this guard can be put into — the first-lockfile
// case below stages a MISSING one, which is the branch that actually exists.
const MALFORMED_NPM = '{ "lockfileVersion": 1, "dependencies": {} }';

test('an unparseable second lockfile is reported and exits 2 when nothing else is wrong', () => {
  const root = stage({ pnpmLock: CLEAN_PNPM, npmLock: MALFORMED_NPM });
  try {
    const { code, stderr } = run(root);
    assert.equal(code, 2);
    assert.ok(stderr.includes('cannot run'), stderr);
    assert.ok(stderr.includes('no "packages" map'), stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a violation outranks an UNPARSEABLE second lockfile — exit 1, scan marked partial', () => {
  // This is the case that exercises the parse-failure `continue`. Pre-fix it exited 2,
  // reporting "cannot run" over a banned package printed one line earlier.
  const root = stage({ pnpmLock: DIRTY_PNPM, npmLock: MALFORMED_NPM });
  try {
    const { code, stderr } = run(root);
    assert.equal(code, 1);
    assert.ok(stderr.includes('ADR-011 violation'), stderr);
    assert.ok(stderr.includes('may be incomplete'), stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a missing FIRST lockfile does not stop the scan of the second', () => {
  // Pre-fix the loop exited on the first failure, so a violation in site/ went unreported.
  const root = stage({
    pnpmLock: null,
    npmLock: JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'site' }, 'node_modules/ox': { version: '2.0.0' } } }),
  });
  try {
    const { code, stderr } = run(root);
    assert.equal(code, 1);
    assert.ok(stderr.includes('site/package-lock.json'), stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

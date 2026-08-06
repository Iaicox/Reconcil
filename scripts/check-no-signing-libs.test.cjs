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

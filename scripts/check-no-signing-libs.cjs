#!/usr/bin/env node
/**
 * Supply-chain guard for the ADR-011 red line (P8, MiCA read-only): no signing or key
 * material ANYWHERE in the dependency tree. The dependency-cruiser `no-signing-libraries`
 * rule only catches DIRECT workspace imports — `doNotFollow: ['node_modules']` means it
 * never traverses transitive deps. This scans BOTH lockfiles in the repo — the pnpm
 * workspace's pnpm-lock.yaml and the standalone site/package-lock.json (site/ is a real npm
 * tree, not a pnpm workspace member, so it needs its own scan) — against the SAME
 * banned-name list (required from the cruiser config — single source of truth, no drift)
 * and fails if any banned package is present anywhere in either resolved tree.
 *
 * This is the actual ADR-011 enforcement mechanism, not a lint nicety — a parsing blind
 * spot here is exactly what an evasion (an aliased install, a git-sourced fork of a banned
 * package, an unrecognized lockfile shape) would exploit. Both parsers below are written to
 * fail LOUD on anything they can't confidently read, rather than silently scanning zero
 * entries and reporting clean.
 */
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const config = require('../.dependency-cruiser.cjs');
const rule = config.forbidden.find((r) => r.name === 'no-signing-libraries');
if (!rule) {
  console.error('could not find the no-signing-libraries rule in .dependency-cruiser.cjs');
  process.exit(2);
}

// Reuse the rule's own regex: `node_modules/(<alternation>)(/|$)` → the inner alternation.
const pathPattern = Array.isArray(rule.to.path) ? rule.to.path[0] : rule.to.path;
const inner = /^node_modules\/\((.+)\)\(\/\|\$\)$/.exec(pathPattern);
if (!inner) {
  console.error('unexpected no-signing-libraries path shape:', pathPattern);
  process.exit(2);
}
const banned = new RegExp(`^(?:${inner[1]})$`);

/**
 * Splits a `name@spec` string (a pnpm packages:/snapshots: key with the quotes already
 * stripped, or an npm alias target) into `{ name, spec }`. Scoped names (`@scope/pkg`)
 * carry a leading `@` that is NOT the name/spec boundary — their boundary is the SECOND
 * `@`; unscoped names split on the FIRST `@`. Returns `null` when no boundary `@` exists
 * (a bare name with no spec attached — see callers for what that means in context).
 */
function splitNameAtSpec(content) {
  const atIndexes = [];
  for (let i = 0; i < content.length; i += 1) if (content[i] === '@') atIndexes.push(i);
  const splitAt = content.startsWith('@') ? atIndexes[1] : atIndexes[0];
  if (splitAt === undefined) return null;
  return { name: content.slice(0, splitAt), spec: content.slice(splitAt + 1) };
}

/**
 * pnpm-lock.yaml: every resolved package is a top-level, block-opening mapping key in
 * `packages:` or `snapshots:` — `  'name@spec':` or `  name@spec:` (quoted only when the
 * name needs it, e.g. leading `@`), with nothing after the colon on that line. That last
 * property (line ends in a bare `:`) is what distinguishes these keys from the `key: value`
 * lines inside a `dependencies:`/`peerDependencies:` block one level deeper — which also
 * sometimes contain scoped names but are never the resolution's own identity.
 *
 * `spec` used to have to start with a digit (plain semver) to be recognized at all, which
 * silently skipped anything resolved via git/tarball/npm-alias/file/link specs (e.g.
 * `pkg@github:owner/repo`, `pkg@https://…`, `pkg@npm:other@1.0.0`) — a banned package
 * pinned to a git fork was invisible. Any spec shape is now accepted; `npm:`-aliased specs
 * additionally have their ALIAS TARGET (the real installed identity, not the local key
 * name) checked too.
 */
function findOffendersInPnpmLock(text) {
  const offenders = new Set();
  for (const rawLine of text.split('\n')) {
    const keyMatch = /^\s+'?([^'\s]+)'?:\s*$/.exec(rawLine);
    if (!keyMatch) continue;
    const split = splitNameAtSpec(keyMatch[1]);
    if (!split) continue; // bare name, no spec — an importers/catalogs declaration, not a resolution
    const { name, spec } = split;
    if (banned.test(name)) offenders.add(name);
    if (spec.startsWith('npm:')) {
      const targetSplit = splitNameAtSpec(spec.slice('npm:'.length));
      const targetName = targetSplit ? targetSplit.name : spec.slice('npm:'.length);
      if (banned.test(targetName)) offenders.add(targetName);
    }
  }
  return offenders;
}

/**
 * site/package-lock.json: only lockfileVersion 2/3 (npm 7+) are understood — both have a
 * flat `packages` map keyed `node_modules/<name>` (nested for transitive deps:
 * `node_modules/a/node_modules/b`; the package name is everything after the LAST
 * `node_modules/` segment). lockfileVersion 1 has no `packages` key at all and would
 * silently scan zero entries — that shape (or any other missing/malformed `packages`) is a
 * hard failure, not a clean pass; see the caller.
 *
 * The key alone is alias-blind: `"my-alias": "npm:real-package@1.2.3"` in package.json
 * keeps the ALIAS as the `node_modules/<key>` folder name, while npm records the TRUE
 * installed identity in that entry's own `name` field. Both are checked.
 */
function findOffendersInNpmLock(text) {
  const data = JSON.parse(text);
  if (typeof data.packages !== 'object' || data.packages === null) {
    throw new Error(
      `unsupported npm lockfile shape (lockfileVersion=${data.lockfileVersion ?? 'unset'}): ` +
        'no "packages" map — this parser only understands lockfileVersion 2/3; a v1-style ' +
        '"dependencies" tree would scan zero entries and silently pass, which is the exact ' +
        'bug this guard exists to prevent',
    );
  }
  const offenders = new Set();
  const marker = 'node_modules/';
  for (const [key, entry] of Object.entries(data.packages)) {
    const idx = key.lastIndexOf(marker);
    if (idx === -1) continue; // the root project's own manifest entry (key === '')
    const keyName = key.slice(idx + marker.length);
    if (banned.test(keyName)) offenders.add(keyName);
    if (entry && typeof entry.name === 'string' && banned.test(entry.name)) {
      offenders.add(entry.name);
    }
  }
  return offenders;
}

// A silently-skipped lockfile is the bug this script exists to fix — both files are
// tracked in this repo (site/ is a normal, always-present checkout directory, not an
// optional submodule or sparse-checkout path), so a missing file is a hard failure, not a
// skip-with-warning.
const lockfiles = [
  {
    path: join(__dirname, '..', 'pnpm-lock.yaml'),
    label: 'pnpm-lock.yaml',
    parse: findOffendersInPnpmLock,
  },
  {
    path: join(__dirname, '..', 'site', 'package-lock.json'),
    label: 'site/package-lock.json',
    parse: findOffendersInNpmLock,
  },
];

function main() {
  let violated = false;
  for (const { path, label, parse } of lockfiles) {
    if (!existsSync(path)) {
      console.error(`ADR-011 guard cannot run — missing lockfile: ${label}`);
      process.exit(2);
    }
    let offenders;
    try {
      offenders = parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.error(`ADR-011 guard cannot run — ${label}: ${err.message}`);
      process.exit(2);
    }
    if (offenders.size > 0) {
      violated = true;
      console.error(`ADR-011 violation — banned signing/key-material package(s) in ${label}:`);
      for (const o of [...offenders].sort()) console.error(`  - ${o}`);
    }
  }

  if (violated) process.exit(1);
  console.log('supply-chain ok: no signing/key-material packages in the dependency tree.');
}

if (require.main === module) main();

module.exports = { banned, findOffendersInPnpmLock, findOffendersInNpmLock, splitNameAtSpec };

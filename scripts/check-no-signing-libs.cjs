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

/** pnpm-lock.yaml: every resolved package is a 2-space-indented `name@version:` key (in
 * both `packages:` and `snapshots:`), incl. scoped and peer-annotated forms. */
function findOffendersInPnpmLock(text) {
  const offenders = new Set();
  for (const line of text.split('\n')) {
    const m = /^\s+'?(@?[^'\s]+?)@[0-9]/.exec(line);
    if (m && banned.test(m[1])) offenders.add(m[1]);
  }
  return offenders;
}

/** site/package-lock.json (npm lockfileVersion 3): every resolved package is a key of the
 * `packages` object shaped `node_modules/<name>` or nested `node_modules/a/node_modules/b`
 * — the package name is everything after the LAST `node_modules/` segment. */
function findOffendersInNpmLock(text) {
  const offenders = new Set();
  const { packages } = JSON.parse(text);
  for (const key of Object.keys(packages ?? {})) {
    if (!key.startsWith('node_modules/') && !key.includes('/node_modules/')) continue;
    const marker = 'node_modules/';
    const name = key.slice(key.lastIndexOf(marker) + marker.length);
    if (banned.test(name)) offenders.add(name);
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

let violated = false;
for (const { path, label, parse } of lockfiles) {
  if (!existsSync(path)) {
    console.error(`ADR-011 guard cannot run — missing lockfile: ${label}`);
    process.exit(2);
  }
  const offenders = parse(readFileSync(path, 'utf8'));
  if (offenders.size > 0) {
    violated = true;
    console.error(`ADR-011 violation — banned signing/key-material package(s) in ${label}:`);
    for (const o of [...offenders].sort()) console.error(`  - ${o}`);
  }
}

if (violated) process.exit(1);
console.log('supply-chain ok: no signing/key-material packages in the dependency tree.');

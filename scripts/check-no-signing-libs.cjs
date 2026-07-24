#!/usr/bin/env node
/**
 * Supply-chain guard for the ADR-011 red line (P8, MiCA read-only): no signing or key
 * material ANYWHERE in the dependency tree. The dependency-cruiser `no-signing-libraries`
 * rule only catches DIRECT workspace imports — `doNotFollow: ['node_modules']` means it
 * never traverses transitive deps. This scans the whole pnpm-lock.yaml against the SAME
 * banned-name list (required from the cruiser config — single source of truth, no drift)
 * and fails if any banned package is present anywhere in the resolved tree.
 */
const { readFileSync } = require('node:fs');
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

// pnpm-lock lists every resolved package as a 2-space-indented `name@version:` key (in
// both `packages:` and `snapshots:`), incl. scoped and peer-annotated forms.
const lockfile = readFileSync(join(__dirname, '..', 'pnpm-lock.yaml'), 'utf8');
const offenders = new Set();
for (const line of lockfile.split('\n')) {
  const m = /^\s+'?(@?[^'\s]+?)@[0-9]/.exec(line);
  if (m && banned.test(m[1])) offenders.add(m[1]);
}

if (offenders.size > 0) {
  console.error('ADR-011 violation — banned signing/key-material package(s) in pnpm-lock.yaml:');
  for (const o of [...offenders].sort()) console.error(`  - ${o}`);
  process.exit(1);
}
console.log('supply-chain ok: no signing/key-material packages in the dependency tree.');

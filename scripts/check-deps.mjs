#!/usr/bin/env node
/**
 * Dependency budget guard.
 *
 * A small, deliberately minimal dependency tree is a security property of this
 * project (fewer packages = smaller supply-chain attack surface), not just a
 * nicety. This script computes the PRODUCTION closure from the lockfile and
 * fails if it grows past a budget, so adding a heavy transitive dependency is a
 * conscious decision — raise the budget in the same commit, with a reason.
 *
 * Reads only package-lock.json, so it needs no install and runs anywhere.
 * Zero dependencies of its own, on purpose.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// The total production closure this repo is allowed to ship. ~13 of these are
// single-platform @napi-rs/keyring prebuilds (only one installs per OS), so the
// real per-machine footprint is far smaller. Raise this only with intent.
const CLOSURE_BUDGET = 52;
const DIRECT_BUDGET = 12;

const prod = new Set();
for (const [key, meta] of Object.entries(lock.packages ?? {})) {
  if (key === '' || meta.dev) continue; // skip the root project and dev-only packages
  prod.add(key.split('node_modules/').pop());
}

const direct = Object.keys(pkg.dependencies ?? {});

let failed = false;
const report = (ok, label, value, budget) => {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${label}: ${value} (budget ${budget})`);
  if (!ok) failed = true;
};

report(direct.length <= DIRECT_BUDGET, 'direct runtime dependencies', direct.length, DIRECT_BUDGET);
report(prod.size <= CLOSURE_BUDGET, 'production closure (direct + transitive)', prod.size, CLOSURE_BUDGET);

if (failed) {
  console.error(
    '\nDependency budget exceeded. Justify the new dependency, or if it is intended,\n' +
      'raise the budget in scripts/check-deps.mjs in the same commit.',
  );
  process.exit(1);
}
console.log('\nDependency budget OK.');

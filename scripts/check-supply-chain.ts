#!/usr/bin/env bun
// Supply-chain gate (substrate-universal runtime backend). Injected into every github installation and
// run by the emitted .github/workflows/security.yml. Two model-independent layers over the install's
// dependency lockfiles:
//   1. Lockfile integrity — every external resolution must come from the official npm registry and carry a
//      sha integrity hash. Catches a bun.lock repointed at a malicious host/tarball, a git+/http:/github:/
//      file: source, or a missing hash — the classes `bun audit` (CVE-only) misses and lockfile-lint/OSV
//      can't parse on bun. Local `@workspace:` packages are exempt (no registry resolution).
//   2. `bun audit` — known-CVE scan against the npm advisory DB, per lockfile.
//
// Auto-discovers every bun.lock in the install (excluding node_modules), so it covers a profile's own
// packages + any service package without a hardcoded path list.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const INTEGRITY = /^sha(1|256|384|512)-/;
const ALLOWED_REGISTRY = 'https://registry.npmjs.org/';

function findLockfiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) walk(full);
      else if (name === 'bun.lock') out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function parseLock(text: string): any {
  // bun.lock is JSONC (trailing commas); strip them before parse.
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

let failures = 0;
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); failures++; };

const lockfiles = findLockfiles(process.cwd());
if (lockfiles.length === 0) {
  console.log('check:supply-chain: no bun.lock found — nothing to verify.');
  process.exit(0);
}

for (const lock of lockfiles) {
  const rel = lock.replace(process.cwd() + '/', '');
  console.log(`• ${rel}`);
  const l = parseLock(await Bun.file(lock).text());
  const packages: Record<string, unknown[]> = l.packages ?? {};

  for (const [key, value] of Object.entries(packages)) {
    const spec = String(value[0] ?? '');
    if (spec.includes('@workspace:')) continue; // local workspace package — no registry resolution
    const resolution = String(value[1] ?? '');
    const integrity = value[value.length - 1];

    if (resolution !== '' && !resolution.startsWith(ALLOWED_REGISTRY)) {
      fail(`${rel}: "${key}" resolves to a non-registry source: ${resolution}`);
      continue;
    }
    if (/(?:^|["\s])(git\+|github:|file:|http:\/\/)/.test(JSON.stringify(value))) {
      fail(`${rel}: "${key}" uses a non-registry protocol (git/github/file/http)`);
      continue;
    }
    if (typeof integrity !== 'string' || !INTEGRITY.test(integrity)) {
      fail(`${rel}: "${key}" (${spec}) is missing a sha integrity hash`);
    }
  }

  const audit = spawnSync('bun', ['audit'], { cwd: dirname(lock), encoding: 'utf8' });
  if (audit.status !== 0) fail(`${rel}: bun audit reported advisories\n${audit.stdout}${audit.stderr}`);
}

if (failures > 0) {
  console.error(`\ncheck:supply-chain FAILED — ${failures} issue(s). A supply-chain change here is human-required.`);
  process.exit(1);
}
console.log('\ncheck:supply-chain OK — lockfiles registry-pinned + integrity-verified, no known advisories.');

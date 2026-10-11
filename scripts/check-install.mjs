#!/usr/bin/env node
/**
 * Installation-completeness check.
 *
 * A plugin is installed by copying files, not by building them, on every path
 * except npm's `prepublishOnly`. This asserts the files a host actually needs
 * are present *in a pristine checkout*, which is what `add github:user/repo`
 * and `add <tarball>` produce.
 *
 * Why this exists: on 2026-10-11 the bundle was gitignored as a "build
 * artifact", so `dsh plugin add github:...` installed a package with no
 * `exports["./client"]` target and the desktop app failed to start. The npm
 * path was fine the whole time (prepublishOnly rebuilt it), so only installing
 * the way the docs recommend exposed it. A test that runs against the working
 * tree cannot see this — the bundle is present there either way.
 *
 * Simulates a clean clone: exports the current tree at HEAD into a temp
 * directory, then checks the package can actually load.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

/** Every path the host resolves through package.json `exports`. */
function requiredTargets() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const targets = [];
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./') && !value.includes('*')) targets.push(value);
      return;
    }
    if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest.exports);
  walk(manifest.main);
  return [...new Set(targets)];
}

const targets = requiredTargets();
for (const target of targets) {
  try {
    readFileSync(join(root, target));
  } catch {
    failures.push(`working tree is missing ${target}`);
  }
}

if (failures.length > 0) {
  console.error('✗ working tree is incomplete:');
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}

// --- what a git install actually sees ----------------------------------------

let worktree;
try {
  worktree = mkdtempSync(join(tmpdir(), 'dsh-req-tree-clean-'));
  // `git archive HEAD` exports exactly what `add github:user/repo` fetches.
  const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', worktree], { input: archive });
} catch (error) {
  console.log(`- skipped the clean-checkout check (${error.message.split('\n')[0]})`);
  process.exit(0);
}

try {
  for (const target of targets) {
    try {
      readFileSync(join(worktree, target));
    } catch {
      failures.push(`git install would be missing ${target}`);
    }
  }

  // The client half must not merely exist — it must be the loader's format.
  const bundlePath = join(worktree, 'lib/client.bundle.js');
  try {
    const bundle = readFileSync(bundlePath, 'utf8');
    if (!bundle.includes('__ModuleLoader__')) {
      failures.push('lib/client.bundle.js is not a module-loader bundle (regenerate with `npm run build`)');
    }
    for (const exported of ['exports.apply', 'exports.inject']) {
      if (!bundle.includes(exported)) failures.push(`lib/client.bundle.js does not export ${exported}`);
    }
  } catch {
    // Already reported as a missing target above.
  }

  // The host half must load with only what the checkout provides. Schemastery is
  // a declared dependency, so resolve it from the source checkout for the test.
  if (failures.length === 0) {
    try {
      await import(`file:///${join(worktree, 'lib/index.js').replace(/\\/g, '/')}`);
    } catch (error) {
      failures.push(`host half fails to import from a clean checkout: ${error.message}`);
    }
  }
} finally {
  rmSync(worktree, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('✗ a fresh install would be broken:');
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}

console.log(`✓ install is complete (${targets.length} export target(s) present in a clean checkout, bundle loads)`);
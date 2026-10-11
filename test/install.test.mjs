/**
 * Tests for the two defects found on 2026-10-11.
 *
 * 1. `client.bundle.js` was gitignored as a "build artifact", so installing via
 *    `dsh plugin add github:user/repo` produced a package whose
 *    `exports["./client"]` target did not exist, and the desktop app failed to
 *    start. `check-install.mjs` covers the packaging side; this file covers the
 *    workspace-selection bug.
 * 2. Switching workspaces in the sidebar left the panel showing the previous
 *    project's tree — the workspace was latched on first render and never
 *    recomputed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pickWorkspace } from '../lib/client.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a clean checkout can actually be installed', () => {
  // `add github:user/repo` and `add <tarball>` fetch the git tree and run no npm
  // scripts, so anything gitignored is simply absent at runtime.
  const worktree = mkdtempSync(join(tmpdir(), 'reqtree-install-'));
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', worktree], { input: archive });

    const manifest = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8'));
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

    for (const target of targets) {
      assert.doesNotThrow(
        () => readFileSync(join(worktree, target)),
        `a clean install would be missing ${target} (is it gitignored as a build artifact?)`,
      );
    }

    const bundle = readFileSync(join(worktree, 'lib/client.bundle.js'), 'utf8');
    assert.ok(bundle.includes('__ModuleLoader__'), 'the bundle must be the loader format');
    assert.ok(bundle.includes('exports.apply'), 'the bundle must export apply()');
    assert.ok(bundle.includes('exports.inject'), 'the bundle must export inject()');
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('the install check runs as part of verify', () => {
  // A check nobody runs catches nothing. It must be wired into `verify`, which
  // `prepublishOnly` runs, so npm publishes cannot regress either.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(manifest.scripts.verify, /check-install/, 'verify must run check-install');
  assert.match(manifest.scripts['prepublishOnly'], /verify/, 'prepublishOnly must run verify');
});

// --- workspace selection -------------------------------------------------------

const sidebarWith = (workspaceId, extra = {}) => ({ sidebar: { mounted: { getSnapshot: () => ({ workspaceId, ...extra }) } } });

test('an explicit user choice wins over the automatic pick', () => {
  assert.equal(pickWorkspace({ tabInfo: sidebarWith('w1'), override: 'w2', fallback: 'w3' }), 'w2');
});

test('an explicit choice is not silently discarded as an empty string', () => {
  assert.equal(pickWorkspace({ tabInfo: sidebarWith('w1'), override: '' , fallback: undefined }), 'w1');
});

test('with no explicit choice, the tab\'s own workspace is used', () => {
  assert.equal(pickWorkspace({ tabInfo: sidebarWith('w1'), override: undefined, fallback: 'w3' }), 'w1');
});

test('switching workspaces changes the pick on the next call', () => {
  // The regression: the first answer was latched, so the panel never followed.
  // Calling twice with different sidebar state must give different answers.
  const first = pickWorkspace({ tabInfo: sidebarWith('w1'), override: undefined, fallback: undefined });
  const second = pickWorkspace({ tabInfo: sidebarWith('w2'), override: undefined, fallback: undefined });
  assert.equal(first, 'w1');
  assert.equal(second, 'w2');
  assert.notEqual(first, second, 'a workspace switch must change the selection');
});

test('a sidebar that reports a cwd is honoured', () => {
  assert.equal(
    pickWorkspace({ tabInfo: sidebarWith(undefined, { cwd: 'C:/proj/a' }), override: undefined, fallback: undefined }),
    'C:/proj/a',
  );
});

test('the single-workspace fallback keeps the panel usable without a sidebar', () => {
  assert.equal(pickWorkspace({ tabInfo: undefined, override: undefined, fallback: 'only' }), 'only');
});

test('nothing identifiable yields undefined rather than a guess', () => {
  // Returning a wrong-but-plausible id would show the wrong project's tree with
  // no indication anything is off.
  assert.equal(pickWorkspace({ tabInfo: undefined, override: undefined, fallback: undefined }), undefined);
  assert.equal(pickWorkspace({}), undefined);
});

test('an empty workspaceId is not treated as a selection', () => {
  assert.equal(pickWorkspace({ tabInfo: sidebarWith(''), override: undefined, fallback: 'w9' }), 'w9');
});
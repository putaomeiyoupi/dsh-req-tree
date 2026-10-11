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
import { buildTreeQuery, pickWorkspace } from '../lib/client.js';

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

const sidebarWith = (mounted) => ({ sidebar: { mounted: { getSnapshot: () => mounted } } });

test('the panel sends its session id, because a workspace is a directory', () => {
  // `mounted` is the *Session* on screen (the sidebar docs are explicit), and the
  // host owns the Session->cwd mapping. Reading `mounted.workspaceId` — which
  // does not exist — silently yielded undefined and pinned the panel to the first
  // registered workspace, so a workspace switch changed nothing on screen.
  assert.deepEqual(pickWorkspace({ sessionId: 'sess-1', tabInfo: undefined, override: undefined }), { sessionId: 'sess-1' });
  assert.deepEqual(pickWorkspace({ sessionId: undefined, tabInfo: sidebarWith('sess-2'), override: undefined }), { sessionId: 'sess-2' });
});

test('switching sessions changes the request on the next render', () => {
  const first = buildTreeQuery(pickWorkspace({ sessionId: 'sess-a', override: undefined }));
  const second = buildTreeQuery(pickWorkspace({ sessionId: 'sess-b', override: undefined }));
  assert.equal(first, '?session=sess-a');
  assert.equal(second, '?session=sess-b');
  assert.notEqual(first, second, 'a session switch must change what the panel requests');
});

test('a session snapshot given as an object is still read', () => {
  assert.deepEqual(pickWorkspace({ sessionId: undefined, tabInfo: sidebarWith({ sessionId: 's3' }), override: undefined }), { sessionId: 's3' });
  assert.deepEqual(pickWorkspace({ sessionId: undefined, tabInfo: sidebarWith({ id: 's4' }), override: undefined }), { sessionId: 's4' });
});

test('an explicit workspace pick no longer exists', () => {
  // The picker was removed: the tab shows its own session's tree, and nothing in
  // the panel can point it at a different project than the sidebar is showing.
  assert.deepEqual(pickWorkspace({ sessionId: 'sess-1', override: 'w9' }), { sessionId: 'sess-1' });
});

test('nothing identifiable sends no selector instead of a guess', () => {
  // The host then answers with its first registered workspace, which is right for
  // a single-project host; a plausible-but-wrong directory would show another
  // project's tree with no indication anything is off.
  assert.deepEqual(pickWorkspace({ sessionId: undefined, tabInfo: undefined }), {});
  assert.equal(buildTreeQuery({}), '');
  assert.equal(buildTreeQuery(undefined), '');
});

test('empty identifiers are not treated as selections', () => {
  assert.deepEqual(pickWorkspace({ sessionId: '', tabInfo: sidebarWith('') }), {});
  assert.equal(buildTreeQuery({ sessionId: '' }), '');
});

test('the host still accepts an explicit workspace id for hand debugging', () => {
  // Kept deliberately: the route supports it even though no UI emits it.
  assert.equal(buildTreeQuery({ workspaceId: 'w9' }), '?workspace=w9');
});

test('identifiers are URL-encoded rather than pasted raw', () => {
  assert.equal(buildTreeQuery({ sessionId: 'a b/c?d' }), '?session=a+b%2Fc%3Fd');
  assert.equal(buildTreeQuery({ workspaceId: 'w&x=1' }), '?workspace=w%26x%3D1');
});

test('the panel renders no workspace picker', async () => {
  // The switcher was a second, conflicting way to say what the sidebar already
  // decides. Its removal is a product decision, so it is asserted like behaviour.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8');
  assert.ok(!source.includes('useWorkspaces'), 'the workspace-list hook is gone');
  assert.ok(!source.includes('WORKSPACES_PATH'), 'the workspaces route constant is gone');
  assert.ok(!source.includes('switcher.label'), 'the switcher locale keys are gone');
  assert.ok(!/<select|'select'/.test(source), 'no select element is rendered');
});
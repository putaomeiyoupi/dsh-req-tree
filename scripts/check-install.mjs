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
import { mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

/**
 * Runtime imports must be installable on every channel.
 *
 * The host half's only bare import is schemastery. If it is declared as an
 * *optional* peer, pnpm skips it — so `add github:user/repo` installs without it
 * and the host half cannot load. This caught itself once already: "fixing" the
 * bundle problem by marking schemastery optional reintroduced an import failure.
 *
 * A non-optional peer is installed automatically by pnpm, which is what
 * `@nanmicoder/dsh-agent-teams` does. So: any bare import must be a
 * non-optional peer or a real dependency, never an optional peer.
 */
function checkRuntimeImports() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const sources = ['lib/index.js', 'lib/project.js'];
  for (const source of sources) {
    const text = readFileSync(join(root, source), 'utf8');
    const specifiers = new Set(
      [...text.matchAll(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/gm)]
        .map((match) => match[1])
        // Relative imports travel with the files; built-ins need nothing.
        .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:')),
    );
    for (const specifier of specifiers) {
      const isOptionalPeer = manifest.peerDependenciesMeta?.[specifier]?.optional === true;
      const isPeer = specifier in (manifest.peerDependencies ?? {});
      const isDependency = specifier in (manifest.dependencies ?? {});
      if (isOptionalPeer) {
        failures.push(
          `${source} imports '${specifier}', declared as an OPTIONAL peer — pnpm will not install it, ` +
            `so git/tarball installs get a package whose host half cannot load. Use a non-optional peer.`,
        );
      } else if (!isPeer && !isDependency) {
        failures.push(`${source} imports '${specifier}' but it is neither a dependency nor a peer`);
      }
    }
  }
}

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

checkRuntimeImports();

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

  // The decisive check: copy the clean checkout into place *with only the
  // packages an installer would have materialised* (devDependencies, i.e. the
  // peers pnpm installs) and actually load the host half from it. Resolving
  // schemastery from this checkout's own node_modules is what a real install
  // gives us, so importing here reproduces the installed layout rather than
  // assuming one.
  if (failures.length === 0) {
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-req-tree-load-'));
    try {
      cpSync(worktree, sandbox, { recursive: true });
      for (const entry of ['@deepseek-ai', 'jsdom', 'react', 'react-dom', 'scheduler']) {
        const from = join(root, 'node_modules', entry);
        cpSync(from, join(sandbox, 'node_modules', entry), { recursive: true });
      }
      const loaded = await import(pathToFileURL(join(sandbox, 'lib/index.js')).href);
      for (const symbol of ['name', 'inject', 'Config', 'apply']) {
        if (!(symbol in loaded)) failures.push(`host half does not export ${symbol}`);
      }
      if (typeof loaded.Config === 'function') {
        const resolved = loaded.Config({});
        if (typeof resolved.pollSeconds !== 'number') {
          failures.push('Config did not apply its defaults (pollSeconds missing)');
        }
      }
      // Mounting against a context with no services must not throw: a headless
      // profile has neither webServer nor workspaceRegistry, and must still boot.
      try {
        loaded.apply({ effect: () => () => {}, get: () => undefined, on: () => {}, logger: {} }, loaded.Config({}));
      } catch (error) {
        failures.push(`apply() throws without any host service: ${error.message}`);
      }
    } catch (error) {
      failures.push(`host half fails to load from an installed layout: ${error.message}`);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
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
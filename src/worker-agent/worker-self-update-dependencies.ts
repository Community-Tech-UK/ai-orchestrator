import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Dependency installs for the worker self-updater (worker-self-update.ts).
 *
 * An update whose commit adds a dependency cannot build until `npm install`
 * runs, and before 2026-10-30 nothing ran it: windows-pc sat on 68a187c with
 * every update refused by `Could not resolve "toml-eslint-parser"`.
 *
 * The risk the original design avoided is Windows refusing to replace a native
 * module a live process has loaded, which leaves node_modules half-installed.
 * The worker loads those binaries lazily (a terminal loads node-pty's, a first
 * database open better-sqlite3's), and neither the supervisor nor Chrome's
 * native host loads them at all, so the updater installs in-process only while
 * none is loaded, and otherwise restarts into a fresh process first.
 */

/** Native modules the worker bundle loads from node_modules (build-worker-agent.ts externals). */
export const WORKER_NATIVE_MODULES = ['better-sqlite3', 'node-pty'] as const;

/** Files whose change between two commits means node_modules must be reinstalled. */
export const DEPENDENCY_FILES = ['package.json', 'package-lock.json'] as const;

/**
 * `--no-save` keeps package-lock.json as committed: npm can rewrite it, and a
 * dirty lockfile would refuse every later `git merge --ff-only`. Quiet output,
 * because the updater buffers it (a killed npm leaves node_modules half-done).
 */
export const NPM_INSTALL_ARGS = ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'] as const;

/**
 * Whether node_modules may lack what `target` needs. `installedFor` is the
 * commit node_modules was last installed for (unknown counts as changed). Git
 * exits 1 when the files differ; any other failure also counts as changed.
 */
export async function dependenciesMayDiffer(
  git: (args: string[]) => Promise<{ code: number }>,
  installedFor: string | null,
  target: string,
): Promise<boolean> {
  if (!installedFor) return true;
  if (installedFor === target) return false;
  return (await git(['diff', '--quiet', installedFor, target, '--', ...DEPENDENCY_FILES])).code !== 0;
}

/**
 * Before restarting so a fresh process can install for `target`: drop the swap
 * marker (the running bundle has been up for minutes, so a crash after this
 * restart must not "restore" the previous bundle over it) and remember the
 * restart. Returns a reason to stop instead when the last restart was for this
 * same commit and a module is loaded again, so the worker never restart-loops.
 */
export function prepareCleanInstallRestart(
  fsOps: { readText(p: string): string | null; writeText(p: string, text: string): void; remove(p: string): void },
  bundleDir: string,
  target: string,
): string | null {
  const marker = path.join(bundleDir, '.deps-restart');
  if (fsOps.readText(marker)?.trim() === target) {
    return `new dependencies need installing, but a native module (${WORKER_NATIVE_MODULES.join(' or ')}) `
      + 'is loaded again after a restart; stop the worker and run npm install by hand '
      + '(scripts/windows/install-worker-dependencies.bat on Windows)';
  }
  fsOps.remove(path.join(bundleDir, '.source-commit.swapped'));
  fsOps.writeText(marker, `${target}\n`);
  return null;
}

/** An install is going ahead with nothing loaded: a later restart for it is a fresh one, not a loop. */
export function clearCleanInstallRestart(fsOps: { remove(p: string): void }, bundleDir: string): void {
  fsOps.remove(path.join(bundleDir, '.deps-restart'));
}

// The compiled binary, which is what Windows locks. Requiring a module's
// JavaScript does not load it: better-sqlite3 opens its binary on the first
// `new Database()`, so a worker that only ran a session has none loaded.
const NATIVE_MODULE_PATH = new RegExp(`[\\\\/]node_modules[\\\\/](${WORKER_NATIVE_MODULES.join('|')})[\\\\/].*\\.node$`);

/** True once this process has loaded the binary of any of the worker's native modules. */
export function workerNativeModulesLoaded(loaded: Iterable<string> = Object.keys(require.cache)): boolean {
  for (const id of loaded) {
    if (NATIVE_MODULE_PATH.test(id)) return true;
  }
  return false;
}

/**
 * npm's own entry script for the node running this worker, run with that node
 * (no npm.cmd shim, as with the build). Windows and nvm4w keep npm beside
 * node.exe; Unix installs keep it under the prefix's lib directory.
 */
export function resolveNpmCli(nodeExecutable: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const nodeDir = path.dirname(nodeExecutable);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

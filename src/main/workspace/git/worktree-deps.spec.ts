/**
 * P6 acceptance: a fresh worktree is provisioned by cloning the root
 * node_modules (not a cold install); the two @ai-orchestrator/* workspace links
 * remain relative symlinks resolving INSIDE the worktree; and the native-ABI
 * binary is preserved (or repaired from the known-good root binary).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { isAbsolute } from 'node:path';
import * as cliEnvironment from '../../cli/cli-environment';
import {
  provisionNodeModules,
  repairWorkspaceLinks,
  assertWorkspaceSymlinks,
  verifyAndRepairNativeAbi,
  provisionWorktreeDependencies,
} from './worktree-deps';

// Real `cp -Rc`/`cp -R` of a synthetic node_modules per test — generous timeout
// so a loaded pre-commit `vitest related` run doesn't trip the default 5s budget.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
let worktree: string;

function createWorkspacePackageLink(repoRoot: string, packageName: string): void {
  const link = join(repoRoot, 'node_modules', '@ai-orchestrator', packageName);
  const relativeTarget = `../../packages/${packageName}`;
  try {
    symlinkSync(relativeTarget, link, 'dir');
  } catch (err) {
    if (process.platform !== 'win32' || (err as NodeJS.ErrnoException).code !== 'EPERM') {
      throw err;
    }
    symlinkSync(join(repoRoot, 'packages', packageName), link, 'junction');
  }
}

function replaceRootWorkspaceLinkWithRealDirectory(packageName: string): void {
  const link = join(root, 'node_modules', '@ai-orchestrator', packageName);
  rmSync(link, { recursive: true, force: true });
  mkdirSync(link, { recursive: true });
  writeFileSync(join(link, 'index.js'), 'module.exports = {};\n');
}

/** Build a synthetic repo `node_modules` mirroring the real workspace layout. */
function seedRootNodeModules(repoRoot: string): void {
  const nm = join(repoRoot, 'node_modules');
  mkdirSync(join(nm, '@ai-orchestrator'), { recursive: true });
  // The packages the links point at must exist before Windows junctions can be created.
  mkdirSync(join(repoRoot, 'packages', 'contracts'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages', 'sdk'), { recursive: true });
  // Relative workspace symlinks, exactly like the real repo (../../packages/*).
  createWorkspacePackageLink(repoRoot, 'contracts');
  createWorkspacePackageLink(repoRoot, 'sdk');
  // A regular dependency file.
  mkdirSync(join(nm, 'left-pad'), { recursive: true });
  writeFileSync(join(nm, 'left-pad', 'index.js'), 'module.exports = () => {};\n');
  // Native module with a fake Electron-ABI binary.
  const release = join(nm, 'better-sqlite3', 'build', 'Release');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, 'better_sqlite3.node'), 'FAKE_ELECTRON_ABI_BINARY_CONTENT');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-deps-root-'));
  worktree = mkdtempSync(join(tmpdir(), 'wt-deps-tree-'));
  seedRootNodeModules(root);
  // The worktree is a checkout of the same repo: it has its own packages/.
  mkdirSync(join(worktree, 'packages', 'contracts'), { recursive: true });
  mkdirSync(join(worktree, 'packages', 'sdk'), { recursive: true });
  writeFileSync(join(worktree, 'package.json'), '{"name":"wt"}\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of [root, worktree]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

/** An executable local npm recorder: installation tests never contact a registry. */
function recordNpmCalls(exitCode = 0): string {
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  const bin = join(worktree, 'tools');
  mkdirSync(bin);
  const script = "require('node:fs').writeFileSync('npm-call.json', JSON.stringify(process.argv.slice(2)));\n"
    + `process.exitCode = ${exitCode};\n`;
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cjs'), script);
    writeFileSync(join(bin, 'npm.cmd'), '@echo off\r\nnode "%~dp0npm.cjs" %*\r\n');
  } else {
    writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node\n${script}`);
    chmodSync(join(bin, 'npm'), 0o755);
  }
  vi.stubEnv('PATH', '');
  const toolPath = [bin, dirname(process.execPath)].join(delimiter);
  vi.spyOn(cliEnvironment, 'buildCliEnv').mockReturnValue({ ...process.env, PATH: toolPath,
    ...(process.platform === 'win32' ? { Path: toolPath } : {}) });
  return join(worktree, 'npm-call.json');
}

describe('worktree installation without root modules', () => {
  it('skips a scripts-only project without invoking npm or creating a lockfile', async () => {
    const marker = recordNpmCalls();
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'script-only', scripts: { test: 'node --test' },
      dependencies: {}, devDependencies: {}, workspaces: [] }));
    await expect(provisionWorktreeDependencies(root, worktree)).resolves.toEqual({ method: 'skipped', symlinks: [], nativeAbi: [] });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    expect(existsSync(join(worktree, 'package-lock.json'))).toBe(false);
  });

  it.each([
    { dependencies: { 'example-package': '1.0.0' } },
    { devDependencies: { 'example-package': '1.0.0' } },
    { optionalDependencies: { 'example-package': '1.0.0' } },
    { peerDependencies: { 'example-package': '1.0.0' } },
    { bundledDependencies: ['example-package'] },
    { bundleDependencies: ['example-package'] },
    { workspaces: ['packages/*'] },
    ...['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']
      .map(name => ({ scripts: { [name]: 'node setup.cjs' } })),
  ])('still installs required packages or lifecycle setup: %j', async manifest => {
    const marker = recordNpmCalls();
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'setup-required', ...manifest }));
    await expect(provisionNodeModules(root, worktree)).resolves.toBe('installed');
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(['install', '--prefer-offline']);
    expect(cliEnvironment.buildCliEnv).toHaveBeenCalled();
  });

  it('preserves npm implicit native build setup', async () => {
    const marker = recordNpmCalls();
    writeFileSync(join(worktree, 'binding.gyp'), '{"targets":[]}');
    await expect(provisionNodeModules(root, worktree)).resolves.toBe('installed');
    expect(existsSync(marker)).toBe(true);
  });

  it('runs a custom setup command for a dependency-free package with the CLI environment', async () => {
    recordNpmCalls();
    writeFileSync(join(worktree, 'setup.cjs'), "require('node:fs').writeFileSync('setup-ran', 'yes');\n");
    await expect(provisionNodeModules(root, worktree, { installCommand: 'node setup.cjs' })).resolves.toBe('installed');
    expect(readFileSync(join(worktree, 'setup-ran'), 'utf8')).toBe('yes');
  });

  it('surfaces a malformed manifest rather than silently skipping its installation', async () => {
    recordNpmCalls();
    writeFileSync(join(worktree, 'package.json'), '{');
    await expect(provisionNodeModules(root, worktree)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('propagates a real installer failure instead of treating setup as complete', async () => {
    const marker = recordNpmCalls(23);
    writeFileSync(join(worktree, 'package.json'), '{"dependencies":{"example-package":"1.0.0"}}');
    await expect(provisionNodeModules(root, worktree)).rejects.toMatchObject({ code: 23 });
    expect(existsSync(marker)).toBe(true);
  });
});

describe('provisionNodeModules', () => {
  it('clones root node_modules (symlink-preserving) into a fresh worktree', async () => {
    const method = await provisionNodeModules(root, worktree);
    expect(['cloned', 'copied']).toContain(method); // clonefile preferred; copy on non-APFS CI

    // Regular file present.
    expect(lstatSync(join(worktree, 'node_modules', 'left-pad', 'index.js')).isFile()).toBe(true);

    // Workspace links copied AS symlinks, still relative, resolving into the worktree.
    const link = join(worktree, 'node_modules', '@ai-orchestrator', 'contracts');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const target = readlinkSync(link);
    if (process.platform === 'win32') {
      expect(isAbsolute(target)).toBe(true);
      expect(resolve(target)).toBe(join(worktree, 'packages', 'contracts'));
    } else {
      expect(isAbsolute(target)).toBe(false);
      expect(target).toBe('../../packages/contracts');
    }
  });

  it('repairs workspace links when a copy dereferences them into real directories', async () => {
    replaceRootWorkspaceLinkWithRealDirectory('contracts');
    replaceRootWorkspaceLinkWithRealDirectory('sdk');

    const method = await provisionNodeModules(root, worktree);
    expect(['cloned', 'copied']).toContain(method);

    const checks = await assertWorkspaceSymlinks(worktree);
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('skips when the worktree already has node_modules (adopted worktree)', async () => {
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    const method = await provisionNodeModules(root, worktree);
    expect(method).toBe('skipped');
  });
});

describe('assertWorkspaceSymlinks', () => {
  it('repairs workspace entries that were copied as real directories', async () => {
    const scopedDir = join(worktree, 'node_modules', '@ai-orchestrator');
    mkdirSync(join(scopedDir, 'contracts'), { recursive: true });
    mkdirSync(join(scopedDir, 'sdk'), { recursive: true });

    const before = await assertWorkspaceSymlinks(worktree);
    expect(before.every((c) => c.ok)).toBe(false);

    await repairWorkspaceLinks(worktree);

    const after = await assertWorkspaceSymlinks(worktree);
    expect(after).toHaveLength(2);
    expect(after.every((c) => c.ok)).toBe(true);
  });

  it('passes for relative symlinks resolving inside the worktree', async () => {
    await provisionNodeModules(root, worktree);
    const checks = await assertWorkspaceSymlinks(worktree);
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('fails when a workspace link was dereferenced into a real directory', async () => {
    await provisionNodeModules(root, worktree);
    // Simulate a bad copy: replace the symlink with a real dir.
    const link = join(worktree, 'node_modules', '@ai-orchestrator', 'contracts');
    rmSync(link, { recursive: true, force: true });
    mkdirSync(link, { recursive: true });
    const checks = await assertWorkspaceSymlinks(worktree);
    const contracts = checks.find((c) => c.name === '@ai-orchestrator/contracts');
    expect(contracts?.ok).toBe(false);
    expect(contracts?.reason).toContain('not a symlink');
  });

  it('fails when a workspace link points outside the worktree (absolute)', async () => {
    await provisionNodeModules(root, worktree);
    const link = join(worktree, 'node_modules', '@ai-orchestrator', 'sdk');
    rmSync(link, { recursive: true, force: true });
    symlinkSync(join(root, 'packages', 'sdk'), link, process.platform === 'win32' ? 'junction' : 'dir'); // absolute → escapes worktree
    const checks = await assertWorkspaceSymlinks(worktree);
    const sdk = checks.find((c) => c.name === '@ai-orchestrator/sdk');
    expect(sdk?.ok).toBe(false);
    expect(sdk?.reason).toMatch(/absolute target/);
  });
});

describe('verifyAndRepairNativeAbi', () => {
  it('reports ok when the cloned binary matches root (same size)', async () => {
    await provisionNodeModules(root, worktree);
    const checks = await verifyAndRepairNativeAbi(root, worktree);
    expect(checks).toEqual([{ module: 'better-sqlite3', status: 'ok' }]);
  });

  it('repairs from the root binary when the worktree binary is missing', async () => {
    await provisionNodeModules(root, worktree);
    // Delete the worktree binary to simulate drift / a copy that lost it.
    rmSync(join(worktree, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), {
      force: true,
    });
    const checks = await verifyAndRepairNativeAbi(root, worktree);
    expect(checks).toEqual([{ module: 'better-sqlite3', status: 'repaired' }]);
    // After repair the binary exists again.
    expect(
      lstatSync(
        join(worktree, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      ).isFile(),
    ).toBe(true);
  });
});

describe('provisionWorktreeDependencies (pipeline)', () => {
  it('clones, asserts symlinks, and verifies native ABI in one pass', async () => {
    const result = await provisionWorktreeDependencies(root, worktree);
    expect(['cloned', 'copied']).toContain(result.method);
    expect(result.symlinks.every((s) => s.ok)).toBe(true);
    expect(result.nativeAbi).toEqual([{ module: 'better-sqlite3', status: 'ok' }]);
  });
});

/**
 * P6 acceptance: a fresh worktree is provisioned by cloning the root
 * node_modules (not a cold install); the two @ai-orchestrator/* workspace links
 * remain relative symlinks resolving INSIDE the worktree; and the native-ABI
 * binary is preserved (or repaired from the known-good root binary).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAbsolute } from 'node:path';
import {
  provisionNodeModules,
  assertWorkspaceSymlinks,
  verifyAndRepairNativeAbi,
  provisionWorktreeDependencies,
} from './worktree-deps';

// Real `cp -Rc`/`cp -R` of a synthetic node_modules per test — generous timeout
// so a loaded pre-commit `vitest related` run doesn't trip the default 5s budget.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
let worktree: string;

/** Build a synthetic repo `node_modules` mirroring the real workspace layout. */
function seedRootNodeModules(repoRoot: string): void {
  const nm = join(repoRoot, 'node_modules');
  mkdirSync(join(nm, '@ai-orchestrator'), { recursive: true });
  // Relative workspace symlinks, exactly like the real repo (../../packages/*).
  symlinkSync('../../packages/contracts', join(nm, '@ai-orchestrator', 'contracts'));
  symlinkSync('../../packages/sdk', join(nm, '@ai-orchestrator', 'sdk'));
  // A regular dependency file.
  mkdirSync(join(nm, 'left-pad'), { recursive: true });
  writeFileSync(join(nm, 'left-pad', 'index.js'), 'module.exports = () => {};\n');
  // Native module with a fake Electron-ABI binary.
  const release = join(nm, 'better-sqlite3', 'build', 'Release');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, 'better_sqlite3.node'), 'FAKE_ELECTRON_ABI_BINARY_CONTENT');
  // The packages the symlinks point at must exist in the checked-out tree.
  mkdirSync(join(repoRoot, 'packages', 'contracts'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages', 'sdk'), { recursive: true });
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
  for (const d of [root, worktree]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
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
    expect(isAbsolute(target)).toBe(false);
    expect(target).toBe('../../packages/contracts');
  });

  it('skips when the worktree already has node_modules (adopted worktree)', async () => {
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    const method = await provisionNodeModules(root, worktree);
    expect(method).toBe('skipped');
  });
});

describe('assertWorkspaceSymlinks', () => {
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
    rmSync(link, { force: true });
    symlinkSync(join(root, 'packages', 'sdk'), link); // absolute → escapes worktree
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

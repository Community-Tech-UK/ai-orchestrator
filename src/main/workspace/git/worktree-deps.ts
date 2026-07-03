/**
 * worktree-deps — P6 spin-up perf for worktree isolation.
 *
 * A cold `npm install` per worktree costs tens of seconds and re-downloads the
 * whole tree. Instead we clone the root `node_modules` with an APFS
 * copy-on-write clone (`cp -Rc`), which is near-instant and shares disk blocks.
 *
 * Three correctness guards travel with the clone:
 *   1. Symlink preservation — the two `@ai-orchestrator/*` workspace links are
 *      RELATIVE symlinks (`../../packages/*`). `cp -R` copies them as symlinks
 *      (it does not follow in-tree symlinks), so they resolve inside the
 *      worktree's own checked-out `packages/`, preserving isolation. We assert
 *      this rather than assume it.
 *   2. Native-ABI integrity — `better-sqlite3` ships an Electron-ABI `.node`
 *      binary. Cloning the already-correct root binary preserves the ABI for
 *      free (this is exactly the "clone + skip-rebuild ships wrong ABI" trap the
 *      plan calls out — sidestepped by cloning the known-good binary, not a
 *      lockfile-gated reinstall). We verify the worktree binary matches root and
 *      repair from root if it drifted.
 *   3. EXDEV / non-APFS fallback — clonefile only works same-volume on APFS.
 *      On failure we fall back to a plain recursive copy, then to the configured
 *      install command, so provisioning never hard-fails the acquire.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../../logging/logger';

const execFileAsync = promisify(execFile);
const logger = getLogger('WorktreeDeps');

/** Relative workspace symlinks that must stay symlinks resolving inside the worktree. */
export const WORKSPACE_SYMLINKS = ['@ai-orchestrator/contracts', '@ai-orchestrator/sdk'] as const;

/** Native modules whose Electron-ABI binary must survive provisioning. */
export const NATIVE_MODULES = ['better-sqlite3'] as const;

export type ProvisionMethod = 'cloned' | 'copied' | 'installed' | 'skipped';

export interface SymlinkCheck {
  name: string;
  ok: boolean;
  reason?: string;
}

export interface NativeAbiCheck {
  module: string;
  status: 'ok' | 'repaired' | 'missing';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function workspaceLinkName(relativePath: string): (typeof WORKSPACE_SYMLINKS)[number] | null {
  const normalized = relativePath.split(path.sep).join('/');
  return WORKSPACE_SYMLINKS.find((name) => name === normalized) ?? null;
}

function workspacePackageTarget(worktreePath: string, name: (typeof WORKSPACE_SYMLINKS)[number]): string {
  return path.join(worktreePath, 'packages', name.split('/').at(-1)!);
}

async function createWorkspaceLink(worktreePath: string, linkPath: string, name: (typeof WORKSPACE_SYMLINKS)[number]) {
  const target = workspacePackageTarget(worktreePath, name);
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.rm(linkPath, { recursive: true, force: true });

  if (process.platform === 'win32') {
    await fs.symlink(target, linkPath, 'junction');
    return;
  }

  const relativeTarget = path.relative(path.dirname(linkPath), target);
  await fs.symlink(relativeTarget, linkPath);
}

export async function repairWorkspaceLinks(worktreePath: string): Promise<void> {
  for (const name of WORKSPACE_SYMLINKS) {
    const linkPath = path.join(worktreePath, 'node_modules', name);
    await createWorkspaceLink(worktreePath, linkPath, name);
  }
}

async function copyNodeModulesWithNode(src: string, dest: string, worktreePath: string): Promise<void> {
  async function copyEntry(srcPath: string, destPath: string, relativePath: string): Promise<void> {
    const workspaceName = workspaceLinkName(relativePath);
    if (workspaceName) {
      await createWorkspaceLink(worktreePath, destPath, workspaceName);
      return;
    }

    const stat = await fs.lstat(srcPath);
    if (stat.isSymbolicLink()) {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const target = await fs.readlink(srcPath);
      const resolved = path.resolve(path.dirname(srcPath), target);
      const targetStat = await fs.stat(resolved).catch(() => null);
      const type = process.platform === 'win32' && targetStat?.isDirectory() ? 'junction' : undefined;
      await fs.symlink(type === 'junction' ? resolved : target, destPath, type);
      return;
    }

    if (stat.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      const entries = await fs.readdir(srcPath);
      await Promise.all(
        entries.map((entry) => copyEntry(path.join(srcPath, entry), path.join(destPath, entry), path.join(relativePath, entry))),
      );
      return;
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(srcPath, destPath);
  }

  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src);
  await Promise.all(entries.map((entry) => copyEntry(path.join(src, entry), path.join(dest, entry), entry)));
}

/**
 * Populate `<worktreePath>/node_modules`. Prefers an APFS clonefile copy of the
 * root `node_modules`; falls back to a plain recursive copy, then to the
 * configured install command. Returns which method was used.
 */
export async function provisionNodeModules(
  repoRoot: string,
  worktreePath: string,
  opts?: { installCommand?: string },
): Promise<ProvisionMethod> {
  const rootModules = path.join(repoRoot, 'node_modules');
  const destModules = path.join(worktreePath, 'node_modules');

  // Already populated (e.g. adopted worktree) — leave it alone.
  if (await pathExists(destModules)) {
    return 'skipped';
  }

  if (await pathExists(rootModules)) {
    // 1) Copy-on-write clone. The clone flag is platform-specific: macOS/BSD `cp`
    //    uses `-c` (clonefile(2)); GNU `cp` (Linux) uses `--reflink=auto`, which
    //    silently falls back to a full copy on filesystems without reflink. Both
    //    copy in-tree symlinks AS symlinks (so the `@ai-orchestrator/*` links stay
    //    relative and resolve inside the worktree). `-Rc` is NOT valid on GNU cp,
    //    so we must branch on platform rather than try the BSD form everywhere.
    const cloneArgs =
      process.platform === 'darwin'
        ? ['-Rc', rootModules, destModules]
        : ['-R', '--reflink=auto', rootModules, destModules];
    try {
      await execFileAsync('cp', cloneArgs, { timeout: 120_000 });
      await repairWorkspaceLinks(worktreePath);
      logger.info('WorktreeDeps: cloned node_modules (copy-on-write)', {
        worktreePath,
        platform: process.platform,
      });
      return 'cloned';
    } catch (cloneErr) {
      logger.warn('WorktreeDeps: clone failed, falling back to plain copy', {
        worktreePath,
        message: cloneErr instanceof Error ? cloneErr.message : String(cloneErr),
      });
    }

    // 2) Plain recursive copy (no reflink; symlinks still preserved by `-R`).
    try {
      await execFileAsync('cp', ['-R', rootModules, destModules], { timeout: 300_000 });
      await repairWorkspaceLinks(worktreePath);
      logger.info('WorktreeDeps: copied node_modules (no clone)', { worktreePath });
      return 'copied';
    } catch (copyErr) {
      logger.warn('WorktreeDeps: plain copy failed, falling back to install', {
        worktreePath,
        message: copyErr instanceof Error ? copyErr.message : String(copyErr),
      });
    }

    try {
      await copyNodeModulesWithNode(rootModules, destModules, worktreePath);
      await repairWorkspaceLinks(worktreePath);
      logger.info('WorktreeDeps: copied node_modules with Node fallback', { worktreePath });
      return 'copied';
    } catch (nodeCopyErr) {
      await fs.rm(destModules, { recursive: true, force: true });
      logger.warn('WorktreeDeps: Node copy failed, falling back to install', {
        worktreePath,
        message: nodeCopyErr instanceof Error ? nodeCopyErr.message : String(nodeCopyErr),
      });
    }
  }

  // 3) Last resort: a real install in the worktree.
  const installCommand = opts?.installCommand ?? 'npm install --prefer-offline';
  if (await pathExists(path.join(worktreePath, 'package.json'))) {
    const { exec } = await import('child_process');
    const execAsync = promisify(exec);
    await execAsync(installCommand, { cwd: worktreePath, timeout: 300_000 });
    logger.info('WorktreeDeps: provisioned node_modules via install command', {
      worktreePath,
      installCommand,
    });
    return 'installed';
  }

  return 'skipped';
}

/**
 * Assert the workspace `@ai-orchestrator/*` entries are still RELATIVE symlinks
 * resolving inside the worktree. A clone that accidentally dereferenced them (or
 * left an absolute link into the root) would silently break isolation — an edit
 * in the worktree would mutate the root's packages.
 */
export async function assertWorkspaceSymlinks(worktreePath: string): Promise<SymlinkCheck[]> {
  const worktreeReal = path.resolve(worktreePath);
  const results: SymlinkCheck[] = [];

  for (const name of WORKSPACE_SYMLINKS) {
    const linkPath = path.join(worktreeReal, 'node_modules', name);
    try {
      const lst = await fs.lstat(linkPath);
      if (!lst.isSymbolicLink()) {
        results.push({ name, ok: false, reason: 'not a symlink (was dereferenced into a real copy)' });
        continue;
      }
      const target = await fs.readlink(linkPath);
      const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(linkPath), target);
      if (resolved !== worktreeReal && !resolved.startsWith(worktreeReal + path.sep)) {
        const prefix = path.isAbsolute(target) ? `absolute target ${target} ` : '';
        results.push({ name, ok: false, reason: `${prefix}resolves outside worktree: ${resolved}` });
        continue;
      }
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const broken = results.filter((r) => !r.ok);
  if (broken.length > 0) {
    logger.warn('WorktreeDeps: workspace symlink assertion failed', { worktreePath, broken });
  }
  return results;
}

async function findNodeBinary(releaseDir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(releaseDir);
    const bin = entries.find((f) => f.endsWith('.node') && !f.startsWith('test'));
    return bin ? path.join(releaseDir, bin) : null;
  } catch {
    return null;
  }
}

/**
 * Verify each native module's worktree `.node` binary matches the root's (same
 * size ⇒ same clonefile source ⇒ same ABI). Repair from the known-good root
 * binary if the worktree copy drifted or is missing. This is the per-worktree
 * native-ABI guard the plan requires — not gated on lockfile equality.
 */
export async function verifyAndRepairNativeAbi(
  repoRoot: string,
  worktreePath: string,
): Promise<NativeAbiCheck[]> {
  const results: NativeAbiCheck[] = [];

  for (const moduleName of NATIVE_MODULES) {
    const rootRelease = path.join(repoRoot, 'node_modules', moduleName, 'build', 'Release');
    const wtRelease = path.join(worktreePath, 'node_modules', moduleName, 'build', 'Release');

    const rootBin = await findNodeBinary(rootRelease);
    if (!rootBin) {
      // Root itself has no binary — out of scope here (guarded by verify-native-abi prebuild).
      results.push({ module: moduleName, status: 'missing' });
      continue;
    }
    const rootStat = await fs.stat(rootBin);
    const wtBin = await findNodeBinary(wtRelease);

    let needsRepair = false;
    if (!wtBin) {
      needsRepair = true;
    } else {
      const wtStat = await fs.stat(wtBin);
      if (wtStat.size !== rootStat.size) needsRepair = true;
    }

    if (!needsRepair) {
      results.push({ module: moduleName, status: 'ok' });
      continue;
    }

    // Repair: copy the root binary (known-correct Electron ABI) into the worktree.
    try {
      await fs.mkdir(wtRelease, { recursive: true });
      const destBin = path.join(wtRelease, path.basename(rootBin));
      await fs.copyFile(rootBin, destBin);
      logger.info('WorktreeDeps: repaired native-ABI binary from root', { moduleName, worktreePath });
      results.push({ module: moduleName, status: 'repaired' });
    } catch (err) {
      logger.warn('WorktreeDeps: native-ABI repair failed', {
        moduleName,
        worktreePath,
        message: err instanceof Error ? err.message : String(err),
      });
      results.push({ module: moduleName, status: 'missing' });
    }
  }

  return results;
}

/**
 * Full P6 provisioning pipeline: populate node_modules, assert workspace
 * symlinks, verify/repair native ABI. Never throws on guard failures — they are
 * logged and reported so acquire stays resilient.
 */
export async function provisionWorktreeDependencies(
  repoRoot: string,
  worktreePath: string,
  opts?: { installCommand?: string },
): Promise<{ method: ProvisionMethod; symlinks: SymlinkCheck[]; nativeAbi: NativeAbiCheck[] }> {
  const method = await provisionNodeModules(repoRoot, worktreePath, opts);
  const symlinks = method === 'skipped' ? [] : await assertWorkspaceSymlinks(worktreePath);
  const nativeAbi = method === 'skipped' ? [] : await verifyAndRepairNativeAbi(repoRoot, worktreePath);
  return { method, symlinks, nativeAbi };
}

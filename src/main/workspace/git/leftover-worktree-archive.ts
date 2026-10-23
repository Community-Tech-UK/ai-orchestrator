/** Recovery archives live outside Git: ignored files may contain private configuration.
 * Git refs retain the baseline commit and a manifest binding it to the private archive.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readdir, readlink, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { LeftoverWorktreeArchive, LeftoverWorktreeRow } from '@contracts/schemas/workspace-tools';
import { isInsideOrEqual, pathCompareKey } from '../../util/path-helpers';
import { gitExec } from './git-exec';

const exec = promisify(execFile);
const ManifestSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), repoRoot: z.string(), path: z.string(),
  branch: z.string().nullable(), tip: z.string().regex(/^[a-f0-9]{40,64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number(), bytes: z.number().nonnegative(),
});
type Manifest = z.infer<typeof ManifestSchema>;
const baselineRef = (id: string) => `refs/aio/work-folder-archives/${id}`;
const manifestRef = (id: string) => `refs/aio/work-folder-archive-manifests/${id}`;
async function syncPath(file: string, directory = false): Promise<void> {
  const handle = await open(file, directory ? 'r' : 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Names, permissions, directories, links and bytes; symlink targets are never traversed. */
export async function worktreeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(folder: string): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      if (folder === root && name === '.git') continue;
      const file = join(folder, name);
      const stat = await lstat(file);
      hash.update(JSON.stringify([relative(root, file), stat.mode & 0o777]));
      if (stat.isSymbolicLink()) hash.update(`link:${await readlink(file)}`);
      else if (stat.isDirectory()) { hash.update('directory'); await walk(file); }
      else if (stat.isFile()) hash.update(`file:${stat.size}:${await fileHash(file)}`);
      else throw new Error('A special file cannot be archived safely; leave this folder in place');
    }
  }
  await walk(root);
  return hash.digest('hex');
}

/** Reject symlink ancestors and paths outside the original managed checkout root. */
export async function verifyRestorablePath(repoRoot: string, target: string): Promise<void> {
  const base = resolve(repoRoot, '.worktrees');
  if (!isInsideOrEqual(base, resolve(target)) || pathCompareKey(base) === pathCompareKey(target)) {
    throw new Error('Recovery is limited to the original managed work folder');
  }
  let ancestor = resolve(repoRoot);
  for (const part of relative(ancestor, target).split(sep)) {
    ancestor = join(ancestor, part);
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Recovery paths cannot use symlinks');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try { await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('The original folder already exists. Recovery will not overwrite it');
}

export class LeftoverWorktreeArchiveService {
  constructor(private readonly archiveRoot: string) {}
  private directory(repoRoot: string, id: string): string {
    return join(this.archiveRoot, createHash('sha256').update(pathCompareKey(repoRoot)).digest('hex'), id);
  }
  private async read(repoRoot: string, id: string): Promise<Manifest> {
    if (!z.string().uuid().safeParse(id).success) throw new Error('Invalid archive identity');
    const manifest = ManifestSchema.parse(JSON.parse(await gitExec(['cat-file', '-p', manifestRef(id)], repoRoot)));
    if (manifest.id !== id || pathCompareKey(manifest.repoRoot) !== pathCompareKey(repoRoot)
      || await gitExec(['rev-parse', baselineRef(id)], repoRoot) !== manifest.tip) {
      throw new Error('The archive and its recovery ref no longer match');
    }
    return manifest;
  }
  private row(m: Manifest): LeftoverWorktreeRow {
    return { repoRoot: m.repoRoot, path: m.path, branch: m.branch, tip: m.tip,
      createdBy: 'harness', owner: null, inUse: false, leftover: true, category: 'saved-work',
      removableByHarness: true, reason: null, dirtyCount: 0, ahead: 0, behind: 0, patchCount: 0,
      fileCount: 0, mergedIntoMain: false, lastCommitAt: m.createdAt,
      ageDays: Math.max(0, Math.floor((Date.now() - m.createdAt) / 86_400_000)), bytes: m.bytes,
      sentence: 'Private recovery archive with all tracked, untracked and ignored files.' };
  }
  async list(repoRoot: string): Promise<LeftoverWorktreeArchive[]> {
    const refs = await gitExec(['for-each-ref', '--format=%(refname)', 'refs/aio/work-folder-archive-manifests/'], repoRoot);
    const result: LeftoverWorktreeArchive[] = [];
    for (const ref of refs.split('\n').filter(Boolean)) {
      const m = await this.read(repoRoot, basename(ref));
      result.push({ id: m.id, row: this.row(m), createdAt: m.createdAt, bytes: m.bytes });
    }
    return result;
  }
  async recoveryRow(repoRoot: string, id: string, target: string): Promise<LeftoverWorktreeRow> {
    const m = await this.read(repoRoot, id);
    if (pathCompareKey(m.path) !== pathCompareKey(target)) throw new Error('Archive is for a different folder');
    await verifyRestorablePath(repoRoot, m.path);
    const file = join(this.directory(repoRoot, id), 'files.tgz');
    if (await fileHash(file) !== m.sha256) throw new Error('Recovery archive failed its checksum');
    return this.row(m);
  }
  async prepare(row: LeftoverWorktreeRow, fingerprint: string): Promise<string> {
    if (isInsideOrEqual(row.repoRoot, this.archiveRoot)) throw new Error('Private archives must live outside the repository');
    const id = randomUUID();
    const directory = this.directory(row.repoRoot, id);
    let manifestObject: string | undefined;
    try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const space = await statfs(directory);
    if (space.bavail * space.bsize < row.bytes * 2) throw new Error('Not enough free disk to archive and verify this folder');
    const file = join(directory, 'files.tgz');
    await exec('tar', ['-czf', file, '--exclude=./.git', '-C', row.path, '.'], { timeout: 10 * 60_000 });
    await chmod(file, 0o600);
    await syncPath(file);
    const scratch = await mkdtemp(join(tmpdir(), 'aio-folder-verify-'));
    try {
      await exec('tar', ['-xzf', file, '-C', scratch], { timeout: 10 * 60_000 });
      if (await worktreeFingerprint(scratch) !== fingerprint || await worktreeFingerprint(row.path) !== fingerprint) {
        throw new Error('Folder changed or archive verification failed. Nothing was removed');
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
    const manifest: Manifest = { version: 1, id, repoRoot: row.repoRoot, path: row.path,
      branch: row.branch, tip: row.tip, sha256: await fileHash(file), fingerprint, createdAt: Date.now(), bytes: (await lstat(file)).size };
    const manifestFile = join(directory, 'manifest.json');
    await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    await syncPath(manifestFile);
    // Persist newly created directory entries as well as file contents before removal.
    for (const folder of [directory, dirname(directory), this.archiveRoot, dirname(this.archiveRoot)]) {
      await syncPath(folder, true);
    }
    const durableGit = ['-c', 'core.fsync=loose-object,reference'];
    manifestObject = await gitExec([...durableGit, 'hash-object', '-w', '--', manifestFile], row.repoRoot);
    await gitExec([...durableGit, 'update-ref', baselineRef(id), row.tip, ''], row.repoRoot);
    await gitExec([...durableGit, 'update-ref', manifestRef(id), manifestObject, ''], row.repoRoot);
    return id;
    } catch (error) {
      if (manifestObject) await gitExec(['update-ref', '-d', manifestRef(id), manifestObject], row.repoRoot).catch(() => undefined);
      await gitExec(['update-ref', '-d', baselineRef(id), row.tip], row.repoRoot).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async restore(repoRoot: string, id: string, target: string): Promise<void> {
    await this.recoveryRow(repoRoot, id, target);
    const m = await this.read(repoRoot, id);
    const scratch = await mkdtemp(join(tmpdir(), 'aio-folder-restore-'));
    try {
      await exec('tar', ['-xzf', join(this.directory(repoRoot, id), 'files.tgz'), '-C', scratch], { timeout: 10 * 60_000 });
      if (await worktreeFingerprint(scratch) !== m.fingerprint) throw new Error('Recovery contents failed verification');
      await verifyRestorablePath(repoRoot, target);
      // Detached recovery preserves branch ownership even if its branch moved meanwhile.
      await gitExec(['worktree', 'add', '--detach', '--', target, m.tip], repoRoot, 5 * 60_000);
      for (const name of await readdir(target)) if (name !== '.git') await rm(join(target, name), { recursive: true, force: true });
      for (const name of await readdir(scratch)) await cp(join(scratch, name), join(target, name), {
        recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true, preserveTimestamps: true,
      });
      if (await worktreeFingerprint(target) !== m.fingerprint) throw new Error('Restored contents need review; the private archive is retained');
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
}

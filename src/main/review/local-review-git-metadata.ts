import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, open, realpath, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface FileIdentity { dev: number; ino: number }

export interface LocalReviewGitMetadata {
  gitDir: string;
  workTree: string;
  index: string;
  commonDir: string;
  dotGitIdentity: FileIdentity;
  gitDirIdentity: FileIdentity;
  commonDirIdentity: FileIdentity;
  indexIdentity: FileIdentity | null;
}

export async function validateLocalReviewGitMetadataLayout(
  workspaceRoot: string,
  probe: (args: string[]) => Promise<string>,
): Promise<LocalReviewGitMetadata> {
  const dotGitPath = path.join(workspaceRoot, '.git');
  const dotGit = await lstat(dotGitPath);
  if ((!dotGit.isDirectory() && !dotGit.isFile()) || dotGit.isSymbolicLink()) {
    throw new Error('Workspace Git metadata is invalid.');
  }
  const dotGitIdentity = identity(dotGit);
  let linkedGitDir: string | null = null;
  if (dotGit.isFile()) {
    const pointer = (await readPointer(dotGitPath)).trim();
    const match = /^gitdir:\s*(.+)$/u.exec(pointer);
    if (!match?.[1] || pointer.includes('\n')) throw new Error('Linked-worktree Git pointer is invalid.');
    linkedGitDir = await realpath(path.resolve(workspaceRoot, match[1]));
  }

  const workTree = await realpath(await probe(['--show-toplevel']));
  const gitDir = await realpath(await probe(['--absolute-git-dir']));
  const commonDir = await realpath(path.resolve(
    workspaceRoot,
    await probe(['--path-format=absolute', '--git-common-dir']),
  ));
  const indexLexical = path.resolve(
    workspaceRoot,
    await probe(['--path-format=absolute', '--git-path', 'index']),
  );
  if (indexLexical !== path.join(gitDir, 'index')) throw new Error('Unexpected Git index location.');
  const index = await resolveOptionalIndex(indexLexical, gitDir);
  if (workTree !== workspaceRoot) throw new Error('Git worktree does not match the approved workspace.');

  if (linkedGitDir === null) {
    if (gitDir !== dotGitPath || commonDir !== dotGitPath) {
      throw new Error('Git worktree metadata is not workspace-local.');
    }
  } else {
    await validateLinkedLayout(dotGitPath, linkedGitDir, gitDir, commonDir);
  }

  const gitDirStats = await lstat(gitDir);
  const commonDirStats = await lstat(commonDir);
  if (!gitDirStats.isDirectory() || !commonDirStats.isDirectory()) {
    throw new Error('Git metadata directories are invalid.');
  }
  const indexStats = await lstat(index).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (indexStats && !indexStats.isFile()) throw new Error('Git index is not a regular file.');
  if (!sameIdentity(dotGitIdentity, await lstat(dotGitPath))) {
    throw new Error('Git metadata changed during validation.');
  }
  return {
    gitDir, workTree, index, commonDir, dotGitIdentity,
    gitDirIdentity: identity(gitDirStats),
    commonDirIdentity: identity(commonDirStats),
    indexIdentity: indexStats ? identity(indexStats) : null,
  };
}

export function sameLocalReviewGitMetadata(
  left: LocalReviewGitMetadata,
  right: LocalReviewGitMetadata,
): boolean {
  return left.gitDir === right.gitDir && left.workTree === right.workTree
    && left.index === right.index && left.commonDir === right.commonDir
    && sameIdentity(left.dotGitIdentity, right.dotGitIdentity)
    && sameIdentity(left.gitDirIdentity, right.gitDirIdentity)
    && sameIdentity(left.commonDirIdentity, right.commonDirIdentity)
    && sameOptionalIdentity(left.indexIdentity, right.indexIdentity);
}

/**
 * Stamp the snapshot with the source index's timestamps.
 *
 * `copyFile` gives the copy the CURRENT time. That mtime necessarily sits after
 * every entry mtime cached inside the index, which switches off Git's
 * "racily clean" protection: an entry is only re-read from disk when its cached
 * mtime is >= the index's own mtime. With a freshly stamped snapshot no entry
 * ever qualifies, so Git trusts its cached stat data outright.
 *
 * That silently loses working-tree edits. Git compares mtime at one-second
 * granularity unless built with USE_NSEC (Apple/Homebrew builds are not), so a
 * file rewritten within the same second as the last index write has a matching
 * cached mtime; if the rewrite also left the byte size unchanged, the size
 * check cannot break the tie either and `status`/`diff` report the file as
 * unmodified. Restoring the original mtime puts those entries back inside the
 * racy window, where Git re-reads content to decide.
 *
 * Best-effort: if the source index disappears between the copy and here, the
 * snapshot simply keeps its own timestamps.
 */
async function preserveIndexTimestamps(
  indexPath: string,
  temporaryIndexPath: string,
): Promise<void> {
  try {
    const source = await lstat(indexPath);
    await utimes(temporaryIndexPath, source.atime, source.mtime);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
}

export async function withLocalReviewGitIndexSnapshot<T>(
  indexPath: string,
  operation: (temporaryIndexPath: string) => Promise<T>,
): Promise<T> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'aio-review-index-'));
  const temporaryIndexPath = path.join(temporaryDirectory, 'index');
  try {
    let copied = true;
    await copyFile(indexPath, temporaryIndexPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      copied = false;
    });
    if (copied) await preserveIndexTimestamps(indexPath, temporaryIndexPath);
    return await operation(temporaryIndexPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function validateLinkedLayout(
  dotGitPath: string,
  linkedGitDir: string,
  gitDir: string,
  commonDir: string,
): Promise<void> {
  if (gitDir !== linkedGitDir || path.dirname(gitDir) !== path.join(commonDir, 'worktrees')) {
    throw new Error('Linked-worktree Git directory is not canonical.');
  }
  const commonPointer = (await readPointer(path.join(gitDir, 'commondir'))).trim();
  if (!commonPointer || await realpath(path.resolve(gitDir, commonPointer)) !== commonDir) {
    throw new Error('Linked-worktree common directory is invalid.');
  }
  const worktreePointer = (await readPointer(path.join(gitDir, 'gitdir'))).trim();
  if (!worktreePointer || path.resolve(gitDir, worktreePointer) !== dotGitPath) {
    throw new Error('Linked-worktree back-pointer is invalid.');
  }
}

async function resolveOptionalIndex(indexPath: string, gitDir: string): Promise<string> {
  try {
    const stats = await lstat(indexPath);
    if (!stats.isFile() || stats.isSymbolicLink() || await realpath(indexPath) !== indexPath) {
      throw new Error('Git index is not a canonical regular file.');
    }
    return indexPath;
  } catch (error) {
    if (!isMissing(error) || await realpath(path.dirname(indexPath)) !== gitDir) throw error;
    return indexPath;
  }
}

async function readPointer(filePath: string): Promise<string> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Git pointer is not a regular file.');
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) throw new Error('Git pointer changed.');
    const output = Buffer.allocUnsafe(4_097);
    let bytesRead = 0;
    while (bytesRead < output.length) {
      const read = await handle.read(output, bytesRead, output.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > 4_096) throw new Error('Git pointer is too large.');
    if (!sameIdentity(opened, await handle.stat())) throw new Error('Git pointer changed.');
    return output.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function identity(value: FileIdentity): FileIdentity { return { dev: value.dev, ino: value.ino }; }
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameOptionalIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left === null ? right === null : right !== null && sameIdentity(left, right);
}
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Raw-byte working-tree snapshots. No add, filters, hooks, config commands or real-repository writes. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { deflate } from 'node:zlib';
import type { TurnFileChange } from '../../shared/types/turn-file-changes.types';

const execFileAsync = promisify(execFile);
const deflateAsync = promisify(deflate);
const MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
export interface WorkingTreeSnapshot {
  tree: string;
  repoRoot: string;
  objectDir: string;
  objectsPath: string;
  completedAt: number;
  paths: readonly string[];
}
export class NotAGitFolderError extends Error {}

function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extra };
}
async function git(cwd: string, args: string[], env = gitEnv(), signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env, signal, timeout: 2_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
  });
  return stdout;
}
function objectFolders(...folders: string[]): string { return [...new Set(folders)].join(path.delimiter); }
function privateEnv(objectDir: string, alternate?: string): NodeJS.ProcessEnv {
  return gitEnv({
    GIT_DIR: path.join(objectDir, '.repo'), GIT_INDEX_FILE: path.join(objectDir, '.index'),
    GIT_OBJECT_DIRECTORY: objectDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    ...(alternate ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate } : {}),
  });
}
async function preparePrivateRepo(objectDir: string): Promise<void> {
  const dir = path.join(objectDir, '.repo');
  await fs.mkdir(path.join(dir, 'refs'), { recursive: true });
  await fs.mkdir(path.join(dir, 'objects'), { recursive: true });
  await fs.writeFile(path.join(dir, 'HEAD'), 'ref: refs/heads/snapshot\n');
  await fs.writeFile(path.join(dir, 'config'), '[core]\n bare = true\n repositoryformatversion = 0\n');
}

/** Lists paths using git's ignore rules, then stores raw blobs in an isolated SHA-1 repository.
 * Index enumeration uses private copies, including split-index bases, so even shared-index
 * mtimes stay untouched. Ignore rules are queried with an empty private index.
 * The deadline and byte/file budgets make large or slow folders truthfully unavailable.
 */
export async function snapshotWorkingTree(workingDirectory: string, objectDir: string,
  signal?: AbortSignal, settledAt?: number, baselinePaths: readonly string[] = []): Promise<WorkingTreeSnapshot> {
  const deadline = Date.now() + 2_000;
  const check = () => { signal?.throwIfAborted(); if (Date.now() > deadline) throw new Error('snapshot deadline'); };
  let repoRoot: string;
  let indexPath: string;
  try {
    const located = (await git(workingDirectory, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-path', 'index'], undefined, signal)).trim().split('\n');
    [repoRoot, indexPath] = located;
    if (!repoRoot || !indexPath) throw new Error('git did not locate the index');
  }
  catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: unknown }).stderr))) throw new NotAGitFolderError('not a git repository');
    throw error;
  }
  await preparePrivateRepo(objectDir);
  const enumerationIndex = path.join(objectDir, '.enumeration-index');
  let copiedBytes = 0;
  const copyIndex = async (source: string, destination: string): Promise<void> => {
    check();
    const stat = await fs.stat(source);
    copiedBytes += stat.size;
    if (copiedBytes > MAX_FILE_BYTES) throw new Error('index byte budget');
    await fs.copyFile(source, destination);
  };
  let tracked = '';
  const hasIndex = await fs.stat(indexPath).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (hasIndex) {
    await copyIndex(indexPath, enumerationIndex);
    const shared = (await fs.readdir(path.dirname(indexPath))).filter(name => /^sharedindex\.[0-9a-f]+$/.test(name));
    if (shared.length > 32) throw new Error('shared-index budget');
    for (const name of shared) await copyIndex(path.join(path.dirname(indexPath), name), path.join(objectDir, '.repo', name));
    tracked = await git(repoRoot, ['ls-files', '--cached', '-z'], { ...privateEnv(objectDir), GIT_INDEX_FILE: enumerationIndex }, signal);
  }
  // Using an empty index preserves original .gitignore/info-exclude/global rules without
  // asking git to read or refresh the real (possibly split) index. Tracked paths are unioned above.
  const others = await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'],
    gitEnv({ GIT_INDEX_FILE: path.join(objectDir, '.empty-index') }), signal);
  const files = [...new Set([...tracked.split('\0'), ...others.split('\0'), ...baselinePaths].filter(Boolean))];
  if (files.length > MAX_FILES) throw new Error('snapshot file budget');
  const env = privateEnv(objectDir);
  await fs.rm(path.join(objectDir, '.index'), { force: true });
  const records: string[] = [];
  let bytes = 0;
  const directories = new Map<string, { dev: number; ino: number; mtimeMs: number; ctimeMs: number }>();
  const checkDirectory = async (directory: string): Promise<boolean> => {
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      // Descendants of a removed folder (including one replaced by a file) are
      // absent from the end tree. Surviving parents still enforce the boundary.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    });
    const previous = directories.get(directory);
    if (previous && (!stat || !stat.isDirectory() || stat.dev !== previous.dev || stat.ino !== previous.ino
      || stat.mtimeMs !== previous.mtimeMs || stat.ctimeMs !== previous.ctimeMs)) {
      throw new Error('folder changed during snapshot');
    }
    // A tracked descendant may remain in the index after its parent becomes a
    // file or a symlink. It is absent from this tree; never follow that parent.
    if (!stat?.isDirectory()) return false;
    if (settledAt !== undefined && (stat.mtimeMs > settledAt || stat.ctimeMs > settledAt)) throw new Error('folder changed after settlement');
    directories.set(directory, stat);
    return true;
  };
  for (const file of files) {
    check();
    const full = path.resolve(repoRoot, file);
    if (!full.startsWith(repoRoot + path.sep)) throw new Error('invalid snapshot path');
    const parents: string[] = [];
    for (let directory = path.dirname(full); ; directory = path.dirname(directory)) {
      parents.push(directory);
      if (directory === repoRoot) break;
    }
    // Validate from root down: even lstat on a deeper parent follows any links
    // above it. Leaf links are still recorded as links by the code below.
    parents.reverse();
    let present = true;
    for (const directory of parents) {
      if (!await checkDirectory(directory)) { present = false; break; }
    }
    if (!present) continue;
    let stat;
    try { stat = await fs.lstat(full); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
    // If somebody changed a file after settlement, do not attribute those bytes to the turn.
    // A changed folder/file makes the boundary uncertain, so no count is reported.
    if (settledAt !== undefined && (stat.mtimeMs > settledAt || stat.ctimeMs > settledAt)) {
      throw new Error('folder changed after settlement');
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('unsupported snapshot entry');
    if (stat.size > MAX_FILE_BYTES || (bytes += stat.size) > MAX_BYTES) throw new Error('snapshot byte budget');
    const body = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(full)) : await fs.readFile(full, { signal });
    const after = await fs.lstat(full);
    if (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.size !== stat.size) throw new Error('file changed during snapshot');
    for (const directory of parents) {
      if (!await checkDirectory(directory)) throw new Error('folder changed during snapshot');
    }
    const blob = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]);
    const hash = createHash('sha1').update(blob).digest('hex');
    const folder = path.join(objectDir, hash.slice(0, 2));
    await fs.mkdir(folder, { recursive: true });
    const compressed = await deflateAsync(blob);
    check();
    await fs.writeFile(path.join(folder, hash.slice(2)), compressed);
    const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
    records.push(`${mode} ${hash}\t${file}\0`);
  }
  for (const directory of directories.keys()) {
    if (!await checkDirectory(directory)) throw new Error('folder changed during snapshot');
  }
  check();
  // --index-info reads only already-written objects; it never consults filters or the real index.
  const child = execFile('git', ['update-index', '-z', '--index-info'], {
    cwd: repoRoot, env, signal, timeout: 2_000, maxBuffer: 16 * 1024 * 1024,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('private index failed')));
    child.stdin!.on('error', reject);
    child.stdin!.end(records.join(''));
  });
  check();
  const tree = (await git(repoRoot, ['write-tree'], env, signal)).trim();
  return { tree, repoRoot, objectDir, objectsPath: objectDir, completedAt: Date.now(), paths: files };
}

/** Files that differ between two snapshots of one repository, with exact line counts. */
export async function diffTrees(
  start: WorkingTreeSnapshot,
  end: WorkingTreeSnapshot,
): Promise<{ files: TurnFileChange[]; total: number }> {
  if (start.tree === end.tree) return { files: [], total: 0 };
  if (start.repoRoot !== end.repoRoot) throw new Error('snapshots are from different repositories');

  // Both trees, the index and all attributes/configuration belong to our private repository.
  const env = privateEnv(end.objectDir, objectFolders(start.objectDir));
  const common = [ 'diff-tree', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '-z'];
  const [names, numbers] = await Promise.all([
    git(start.repoRoot, [...common, '--name-status', start.tree, end.tree], env),
    git(start.repoRoot, [...common, '--numstat', start.tree, end.tree], env),
  ]);

  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  for (const record of numbers.split('\0')) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record);
    if (match) {
      counts.set(match[3], {
        added: match[1] === '-' ? null : Number(match[1]),
        deleted: match[2] === '-' ? null : Number(match[2]),
      });
    }
  }
  const tokens = names.split('\0').filter((token) => token.length > 0);
  const files: TurnFileChange[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const code = tokens[index];
    const file = tokens[index + 1];
    const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
    files.push({ path: file, status, ...(counts.get(file) ?? { added: null, deleted: null }) });
  }
  return { files, total: files.length };
}

/** Filesystem selection and finite traversal limits shared by both discovery paths. */
import * as fs from 'fs/promises';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';

const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.worktrees', '.claude', '.aio-review', '_archive', 'archive', '_scratch', 'dist',
]);
const COPY_DIR_RE = /snapshot|evidence|observation|receipts/i;
const MAX_CANDIDATES = 5_000;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;
const MAX_IGNORE_BYTES = 1024 * 1024;

/** These are the only wildcard characters supported by globToRegExp. */
export function isExactPlanQueueSelection(glob?: string): boolean {
  return !!glob?.trim() && !/[*?]/.test(glob);
}

function incomplete(limit: string): Error {
  return new Error(`Document discovery is incomplete: ${limit}. Select a specific file or a narrower folder pattern.`);
}

function skipDirectory(name: string, withinPlans: boolean): boolean {
  return SKIPPED_DIRS.has(name) || COPY_DIR_RE.test(name) || (withinPlans && name.toLowerCase() === 'plans');
}

async function readIgnore(repoRoot: string): Promise<Ignore> {
  const rules = ignore();
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path.join(repoRoot, '.planqueueignore'), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return rules;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_IGNORE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_IGNORE_BYTES) throw incomplete('.planqueueignore exceeds 1 MiB');
    return rules.add(buffer.toString('utf8', 0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function exactPath(repoRoot: string, glob: string, rules: Ignore): Promise<string[]> {
  const normalized = glob.replace(/\\/g, '/');
  if (path.isAbsolute(normalized)) return [];
  const file = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
  const parts = relative.split(path.sep);
  if (parts.length > MAX_DEPTH + 1) throw incomplete(`folder depth exceeds ${MAX_DEPTH}`);
  let withinPlans = false;
  for (let index = 0; index < parts.length; index++) {
    const directory = index < parts.length - 1;
    const part = parts[index];
    const relativePart = parts.slice(0, index + 1).join('/');
    if ((directory && skipDirectory(part, withinPlans)) || rules.ignores(relativePart + (directory ? '/' : ''))) return [];
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(path.join(repoRoot, ...parts.slice(0, index + 1)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (directory ? !stat.isDirectory() : !stat.isFile()) return [];
    withinPlans ||= directory && part.toLowerCase() === 'plans';
  }
  return [file];
}

/** Check every literal ancestor before narrowing traversal to the selected folder. */
async function wildcardStart(repoRoot: string, glob: string, rules: Ignore, includeCopies: boolean) {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(normalized)) return null;
  const parts: string[] = [];
  for (const part of normalized.split('/').slice(0, -1)) {
    if (/[*?]/.test(part)) break;
    if (!part || part === '.' || part === '..') return null;
    parts.push(part);
  }
  if (parts.length > MAX_DEPTH) throw incomplete(`folder depth exceeds ${MAX_DEPTH}`);
  let withinPlans = false;
  let copy = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const relative = parts.slice(0, index + 1).join('/');
    if (SKIPPED_DIRS.has(part) || (!includeCopies && skipDirectory(part, withinPlans)) || rules.ignores(`${relative}/`)) return null;
    try {
      if (!(await fs.lstat(path.join(repoRoot, relative))).isDirectory()) return null;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
    copy ||= COPY_DIR_RE.test(part) || (withinPlans && part.toLowerCase() === 'plans');
    withinPlans ||= part.toLowerCase() === 'plans';
  }
  return { dir: path.join(repoRoot, ...parts), relative: parts.join('/'), withinPlans, copy, depth: parts.length };
}

/** Exact selections never walk unrelated directories; wildcard results are complete or throw. */
export async function selectPlanQueuePaths(
  repoRoot: string,
  glob: string,
  matcher: RegExp,
  wanted: (name: string) => boolean,
): Promise<string[]> {
  const rules = await readIgnore(repoRoot);
  if (isExactPlanQueueSelection(glob)) {
    return (await exactPath(repoRoot, glob, rules)).filter(file => wanted(path.basename(file)));
  }
  const files: string[] = [];
  let entries = 0;
  async function walk(dir: string, relativeDir: string, withinPlans: boolean, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw incomplete(`folder depth exceeds ${MAX_DEPTH}`);
    // Async iteration closes the directory even when a limit or I/O error throws.
    const directory = await fs.opendir(dir);
    for await (const entry of directory) {
      if (++entries > MAX_ENTRIES) throw incomplete('more than 100,000 filesystem entries');
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectory(entry.name, withinPlans) && !rules.ignores(`${relative}/`)) {
          await walk(full, relative, withinPlans || entry.name.toLowerCase() === 'plans', depth + 1);
        }
      } else if (entry.isFile() && wanted(entry.name) && matcher.test(relative) && !rules.ignores(relative)) {
        if (files.length === MAX_CANDIDATES) throw incomplete('more than 5,000 matching documents');
        files.push(full);
      }
    }
  }
  const start = await wildcardStart(repoRoot, glob, rules, false);
  if (start) await walk(start.dir, start.relative, start.withinPlans, start.depth);
  return files.sort();
}

/** Advisory copy count has its own budget: copies cannot crowd real plans out. */
export async function countHiddenPlanQueueCopies(
  repoRoot: string, glob: string, matcher: RegExp, wanted: (name: string) => boolean,
): Promise<{ count: number; complete: boolean }> {
  const rules = await readIgnore(repoRoot);
  let entries = 0;
  let count = 0;
  let complete = true;
  async function walk(dir: string, relativeDir: string, withinPlans: boolean, copy: boolean, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) { complete = false; return; }
    const directory = await fs.opendir(dir);
    for await (const entry of directory) {
      if (++entries > MAX_ENTRIES) { complete = false; break; }
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || rules.ignores(`${relative}/`)) continue;
        await walk(path.join(dir, entry.name), relative, withinPlans || entry.name.toLowerCase() === 'plans',
          copy || COPY_DIR_RE.test(entry.name) || (withinPlans && entry.name.toLowerCase() === 'plans'), depth + 1);
        if (entries > MAX_ENTRIES) break;
      } else if (copy && entry.isFile() && wanted(entry.name) && matcher.test(relative) && !rules.ignores(relative)) {
        count++;
      }
    }
  }
  const start = await wildcardStart(repoRoot, glob, rules, true);
  if (start) await walk(start.dir, start.relative, start.withinPlans, start.copy, start.depth);
  return { count, complete };
}

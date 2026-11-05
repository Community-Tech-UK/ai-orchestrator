/**
 * Plan Queue planning files — never committed to an item branch, never deleted.
 *
 * Active planning documents (`_plan`, `_spec`, `_livetest`, `_history`, decisions;
 * the one pattern is in `workspace/git/active-plan-pattern.ts`) stay untracked
 * in the ROOT checkout, so the commit hook refuses them. A worker that creates
 * one inside its own work folder would have it swept onto the item branch by
 * the checkpoint's `git add -A`, refused at landing, and then removed by
 * landing cleanup. So Harness moves every untracked one to the same path in the
 * root checkout first:
 *
 *  - a root file is NEVER replaced, not even one this same item moved earlier: an
 *    in-place update cannot be made safe against an edit saved between the check
 *    and the write. When the destination already exists with different bytes the
 *    new file goes beside it as `<name>.from-queue-<item>[-n].md`, created
 *    exclusively so it can never replace anything;
 *  - every destination must stay inside the root checkout, with no symlinked
 *    folder leading out of it;
 *  - a file that cannot be moved is copied to a rescue folder and reported as
 *    failed, so the caller can keep it out of the commit and out of cleanup.
 *
 * Tracked files are never touched: only files `git ls-files --others` lists.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'node:crypto';
import { getLogger } from '../logging/logger';
import { isActivePlanDocumentPath } from '../workspace/git/active-plan-pattern';
import { gitExec } from '../workspace/git/git-exec';
import { getPlanQueueDataDir } from './plan-queue-data-dir';

const logger = getLogger('PlanQueuePlanningFiles');

const MAX_BESIDE_COPIES = 1_000;

export interface PlanningMoveContext {
  itemId: string;
  worktreePath: string;
  /** The root checkout the files belong in. */
  repoRoot: string;
  /** Paths Harness provisioned into the work folder; never the worker's files. */
  provisioned?: readonly string[];
}

export interface PlanningMoveReport {
  /** Repo-relative paths now at the same path in the root checkout (or already identical there). */
  moved: string[];
  /** Files the root already had in a different state: saved beside it, root copy untouched. */
  beside: { path: string; copy: string }[];
  /** Files that could not be moved. They are still in the work folder, and a rescue copy was kept when possible. */
  failed: PlanningMoveFailure[];
}

export interface PlanningMoveFailure {
  path: string;
  reason: string;
  /** Where the rescue copy is, or null when none could be made. */
  rescue: string | null;
  /** True when the file is real content that has no copy anywhere else, so deleting it would lose it. */
  unsafeToDelete: boolean;
}

class PlanningMoveRefusal extends Error {}

/** One relocation at a time: the record file and the root checkout are shared by every item. */
let serial: Promise<unknown> = Promise.resolve();

function safeName(itemId: string): string {
  return itemId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200) || 'item';
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function lstatOrNull(target: string): Promise<import('fs').Stats | null> {
  try { return await fs.lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function harnessDir(repoRoot: string, ...parts: string[]): Promise<string> {
  const common = await gitExec(['rev-parse', '--git-common-dir'], repoRoot);
  return path.join(path.resolve(repoRoot, common), 'aio-plan-queue', ...parts);
}

/** The untracked planning files in a work folder (ignored and provisioned paths aside). */
export async function listUntrackedPlanningFiles(worktreePath: string, provisioned: readonly string[] = []): Promise<string[]> {
  const listed = await gitExec(['ls-files', '-z', '--others', '--exclude-standard'], worktreePath);
  return listed.split('\0').filter((file) => file && isActivePlanDocumentPath(file)
    && !provisioned.some((p) => file === p || file.startsWith(`${p}/`)));
}

/** Pathspec exclusions that keep these files out of a `git add` / `git status`. */
export function planningExclusions(failed: readonly PlanningMoveFailure[]): string[] {
  return failed.map((file) => `:(exclude,literal)${file.path}`);
}

// ---- record of what this item moved ------------------------------------------

/**
 * Only what the fix prompt needs to tell the worker where its files went; nothing here decides whether a root
 * file may be written. Kept in Harness's folder inside the repository's own Git directory, like the
 * document-merge backups, so it survives a restart and the removal of the work folder.
 */
interface PlanningRecord {
  /** Repo-relative paths this item put at the same path in the root checkout. */
  moved: string[];
  /** Copies saved beside an existing root file, per path. */
  beside: Record<string, string[]>;
}

async function recordFile(repoRoot: string, itemId: string): Promise<string> {
  return path.join(await harnessDir(repoRoot, 'planning-moves'), `${safeName(itemId)}.json`);
}

async function readRecord(file: string): Promise<PlanningRecord> {
  const record: PlanningRecord = { moved: [], beside: {} };
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Record<keyof PlanningRecord, unknown>>;
    // Records written before hashes were dropped keyed `moved` by path; only the paths matter now.
    const moved = Array.isArray(parsed.moved) ? parsed.moved : Object.keys((parsed.moved ?? {}) as object);
    record.moved = moved.filter((file): file is string => typeof file === 'string');
    for (const [key, value] of Object.entries(parsed.beside ?? {})) {
      if (Array.isArray(value)) record.beside[key] = value.filter((copy): copy is string => typeof copy === 'string');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Plan queue: the moved-planning-files record could not be read', { file, error: String(error) });
    }
  }
  return record;
}

async function writeRecord(file: string, record: PlanningRecord): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temp, file);
}

/** Forget an item's moved-file record once the item has ended. */
export async function clearPlanningMoveRecord(repoRoot: string, itemId: string): Promise<void> {
  await fs.rm(await recordFile(repoRoot, itemId), { force: true });
}

// ---- moving ----------------------------------------------------------------

function validateRelative(rel: string): string[] {
  const segments = rel.split('/');
  if (!rel || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel) || path.posix.isAbsolute(rel)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git')) {
    throw new PlanningMoveRefusal(`${rel === '' ? '(empty)' : rel} is not a path inside the project`);
  }
  return segments;
}

/**
 * Create one folder whose parent was just checked. The parent can be swapped for a link in the gap and Node
 * cannot create a folder relative to an opened one, so the result is proven instead: the parent is resolved
 * again and must still be inside the root. If not, the folder just made sits outside, so the empty folder is
 * removed (`rmdir` only ever removes an empty one) and the move is refused. A folder can briefly exist
 * outside the root in that gap; nothing is ever written into it, and the file create is checked the same way.
 */
async function makeFolderInside(rootReal: string, folder: string): Promise<void> {
  const changed = new PlanningMoveRefusal(`the folder ${path.relative(rootReal, folder)} changed while it was being created, so nothing was written`);
  try {
    await fs.mkdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw changed;
    throw error;
  }
  const parent = await fs.realpath(path.dirname(folder));
  if (!insideRoot(rootReal, parent)) {
    await fs.rmdir(path.join(parent, path.basename(folder))).catch((error: unknown) => {
      logger.warn('Plan queue: could not remove a folder made outside the project', { folder: path.join(parent, path.basename(folder)), error: String(error) });
    });
    throw changed;
  }
}

/** Create the destination folder step by step, refusing any step that leaves the root. */
async function ensureFolderInsideRoot(rootReal: string, segments: readonly string[]): Promise<string> {
  let current = rootReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) {
      await makeFolderInside(rootReal, current);
      continue;
    }
    const real = await fs.realpath(current);
    if (!insideRoot(rootReal, real)) throw new PlanningMoveRefusal(`the folder ${path.relative(rootReal, current)} leads outside the project`);
    if (!(await fs.stat(real)).isDirectory()) throw new PlanningMoveRefusal(`${path.relative(rootReal, current)} is a file, not a folder`);
    current = real;
  }
  return current;
}

async function writeNew(target: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await fs.open(target, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

/**
 * Create a new file inside the root checkout. The folder was checked earlier, but a folder can be swapped for a
 * link in the gap before the create, and Node has no way to create a file relative to an opened folder. So the
 * create is exclusive and empty, and nothing is written until the new file is proven to sit inside the root:
 * the folder is resolved again and the file found there must be the very file just created (same device and
 * inode). If not, the empty file is removed (only when found by that identity) and the move is refused.
 */
async function writeNewInside(rootReal: string, target: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await fs.open(target, 'wx', mode);
  try {
    const created = await handle.stat();
    const folder = await fs.realpath(path.dirname(target));
    const found = path.join(folder, path.basename(target));
    const there = await lstatOrNull(found);
    const sameFile = there !== null && there.isFile() && there.dev === created.dev && there.ino === created.ino;
    if (!sameFile || !insideRoot(rootReal, folder)) {
      if (sameFile) await fs.rm(found, { force: true });
      throw new PlanningMoveRefusal(`the folder for ${path.relative(rootReal, target)} changed while the file was being created, so nothing was written`);
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function saveBeside(rootReal: string, dest: string, itemId: string, bytes: Buffer, mode: number): Promise<string> {
  const stem = path.basename(dest).replace(/\.md$/, '');
  // Same short suffix the item's branch name uses; the number below keeps copies unique.
  const slug = itemId.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase() || 'item';
  for (let n = 1; n <= MAX_BESIDE_COPIES; n += 1) {
    const copy = path.join(path.dirname(dest), `${stem}.from-queue-${slug}${n > 1 ? `-${n}` : ''}.md`);
    try { await writeNewInside(rootReal, copy, bytes, mode); return copy; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new PlanningMoveRefusal('too many earlier copies sit beside this file');
}

type OneResult = { kind: 'moved' } | { kind: 'beside'; copy: string };

async function relocateOne(ctx: PlanningMoveContext, rootReal: string, rel: string, record: PlanningRecord, recordPath: string): Promise<OneResult> {
  const segments = validateRelative(rel);
  const source = path.join(ctx.worktreePath, ...segments);
  const sourceStat = await lstatOrNull(source);
  if (!sourceStat) throw new PlanningMoveRefusal(`${rel} is no longer in the work folder`);
  if (!sourceStat.isFile()) throw new PlanningMoveRefusal(`${rel} is not a regular file`);
  const mode = sourceStat.mode & 0o777;
  const bytes = await fs.readFile(source);

  const folder = await ensureFolderInsideRoot(rootReal, segments.slice(0, -1));
  const dest = path.join(folder, segments[segments.length - 1]);
  const destStat = await lstatOrNull(dest);
  let result: OneResult = { kind: 'moved' };

  if (!destStat) {
    try { await writeNewInside(rootReal, dest, bytes, mode); }
    catch (error) {
      // Someone created the path first: take the existing-file branch, never overwrite.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return relocateOne(ctx, rootReal, rel, record, recordPath);
    }
    if (!record.moved.includes(rel)) record.moved.push(rel);
    await writeRecord(recordPath, record);
  } else if (!destStat.isFile()) {
    throw new PlanningMoveRefusal(`${rel} already exists in the project as something other than a regular file`);
  } else if (!bytes.equals(await fs.readFile(dest))) {
    // The root file is never replaced: the worker's version goes beside it.
    const copy = await saveBeside(rootReal, dest, ctx.itemId, bytes, mode);
    record.beside[rel] = [...(record.beside[rel] ?? []), path.relative(rootReal, copy)];
    await writeRecord(recordPath, record);
    result = { kind: 'beside', copy };
  }
  // Identical bytes already at the root: nothing to add, and nothing is lost by removing the work-folder copy.
  await fs.rm(source, { force: true });
  return result;
}

async function copyToRescue(ctx: PlanningMoveContext, rel: string, stamp: string): Promise<string> {
  const source = path.join(ctx.worktreePath, ...validateRelative(rel));
  const stat = await lstatOrNull(source);
  if (!stat?.isFile()) throw new PlanningMoveRefusal(`${rel} is not a regular file`);
  const target = path.join(getPlanQueueDataDir(), 'planning-rescue', safeName(ctx.itemId), stamp, ...validateRelative(rel));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeNew(target, await fs.readFile(source), stat.mode & 0o777);
  return target;
}

async function relocateAll(ctx: PlanningMoveContext, candidates: readonly string[]): Promise<PlanningMoveReport> {
  const report: PlanningMoveReport = { moved: [], beside: [], failed: [] };
  if (!candidates.length) return report;
  const rootReal = await fs.realpath(ctx.repoRoot);
  const recordPath = await recordFile(ctx.repoRoot, ctx.itemId);
  const record = await readRecord(recordPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const rel of candidates) {
    try {
      const result = await relocateOne(ctx, rootReal, rel, record, recordPath);
      if (result.kind === 'beside') report.beside.push({ path: rel, copy: path.relative(rootReal, result.copy) });
      else report.moved.push(rel);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      let rescue: string | null = null;
      let unsafeToDelete = false;
      // A path that is not inside the project is never read, not even for a rescue copy.
      const inside = (() => { try { validateRelative(rel); return true; } catch { return false; } })();
      const stat = inside ? await lstatOrNull(path.join(ctx.worktreePath, ...rel.split('/'))).catch(() => null) : null;
      if (stat?.isFile()) {
        try { rescue = await copyToRescue(ctx, rel, stamp); }
        catch (rescueError) {
          unsafeToDelete = true;
          logger.error('Plan queue: a planning file could not be moved or copied to the rescue folder', rescueError instanceof Error ? rescueError : undefined, { itemId: ctx.itemId, file: rel });
        }
      }
      logger.warn('Plan queue: a planning file could not be moved to the root checkout', { itemId: ctx.itemId, file: rel, reason, rescue });
      report.failed.push({ path: rel, reason, rescue, unsafeToDelete });
    }
  }
  if (report.moved.length || report.beside.length) {
    logger.info('Plan queue: planning files moved to the root checkout', { itemId: ctx.itemId, moved: report.moved.length, beside: report.beside.length });
  }
  return report;
}

/**
 * Move planning files from the work folder to the root checkout under the rules
 * above. `candidates` are repo-relative paths; by default every untracked
 * planning file in the work folder. Never throws for one file's failure: that
 * file is reported in `failed`.
 */
export async function relocatePlanningFiles(ctx: PlanningMoveContext, candidates?: readonly string[]): Promise<PlanningMoveReport> {
  const run = async (): Promise<PlanningMoveReport> =>
    relocateAll(ctx, candidates ?? await listUntrackedPlanningFiles(ctx.worktreePath, ctx.provisioned));
  const result = serial.then(run, run);
  serial = result.catch(() => undefined);
  return result;
}

/**
 * Where this item's planning files went, for the fix prompt (the worker may not remember, and must
 * edit them at the root path from now on), or null when none moved.
 */
export async function describePlanningMoves(repoRoot: string, itemId: string): Promise<string | null> {
  const record = await readRecord(await recordFile(repoRoot, itemId));
  const lines = [
    ...record.moved.map((file) => `${file} is now at ${path.join(repoRoot, file)}`),
    ...Object.entries(record.beside).flatMap(([file, copies]) => copies.map((copy) => `${file} was saved as ${path.join(repoRoot, copy)}, because the root already had a different ${path.basename(file)}`)),
  ];
  return lines.length ? `${lines.join('\n')}\nEdit planning files at those root paths, not in your worktree.` : null;
}

/** What the item's note tells James after a move, or null when nothing moved or failed. */
export function planningMoveNote(report: PlanningMoveReport): string | null {
  const parts: string[] = [];
  if (report.moved.length) parts.push(`Planning files the worker created in its work folder were moved to the main project folder: ${report.moved.join(', ')}.`);
  for (const copy of report.beside) {
    parts.push(`${copy.path} already exists in the main project folder with different content, so it was not overwritten; the worker's version was saved beside it as ${copy.copy}.`);
  }
  for (const file of report.failed) {
    parts.push(`${file.path} could not be moved to the main project folder (${file.reason}). It was left out of the saved work${file.rescue ? ` and a copy is kept at ${file.rescue}` : ', and no copy could be made'}.`);
  }
  return parts.length ? parts.join(' ') : null;
}

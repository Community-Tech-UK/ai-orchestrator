/**
 * Changes made directly on the base branch, and whether a job would undo one
 * (docs/plans/2026-11-16-queue-must-not-undo-james-changes_plan.md).
 *
 * A "direct change" is a commit on the base branch, newer than the plan, that lacks the "Landed by Plan Queue" line.
 * Every commit in this repository is authored by James, agent commits included, so the author proves nothing; the
 * missing line is what marks it. A plan's text can be older than such a change, and a worker or checker that follows
 * the text puts the old behaviour back. So agents are given the list (prompts) and landing refuses a job that undoes
 * one (`findUndoneDirectChanges`), unless James chose the job's version on the Plan Queue page.
 */

import { createHash } from 'crypto';
import { statSync } from 'fs';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { gitExec } from '../workspace/git/git-exec';
import { loadGeneratedFiles } from './plan-queue-generated-files';
import { hasCheckout } from './plan-queue-orphan-checkout';
import { planSteps } from './plan-queue-plan-extract';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import type { StalePlanNote } from './plan-queue-document-status';

const logger = getLogger('PlanQueueDirectChanges');

/** The line every Plan Queue landing commit carries (plan-queue-item-landing.ts). */
export const QUEUE_LANDING_MARK = 'Landed by Plan Queue';
/** That exact line, so a direct commit that merely quotes the phrase keeps its protection. */
const QUEUE_LANDING_LINE = /^Landed by Plan Queue after \d+ verification round\(s\)\.$/m;

/** Distinct matching lines a job must both remove and put back before it counts as undoing a change. */
const UNDO_LINE_THRESHOLD = 3;
/** The most direct changes one prompt lists, newest first. */
const PROMPT_LIST_LIMIT = 20;
/** The most files listed per change in a prompt. */
const PROMPT_FILES_PER_CHANGE = 8;

export interface DirectChange {
  commit: string;
  /** ISO commit date. */
  date: string;
  subject: string;
  files: string[];
}

/** One file of one direct change that a job would undo. */
export interface UndoneDirectChange {
  commit: string;
  date: string;
  subject: string;
  file: string;
  /** Lines the direct change added that the job removes. */
  removedLines: string[];
  /** Lines the direct change removed that the job adds back. */
  restoredLines: string[];
  /** Ties James's "take the job's version" to these exact lines (see `undoFingerprint`). */
  fingerprint: string;
}

/**
 * When the plan was written: the date in its file name (`2026-10-10-...`, local midnight), else the file's creation
 * time. Plan files are untracked, so git has no date for them. Null when neither can be read.
 */
export function planReferenceTime(documentPath: string): number | null {
  const named = /^(\d{4})-(\d{2})-(\d{2})-/.exec(path.basename(documentPath));
  if (named) {
    const time = new Date(Number(named[1]), Number(named[2]) - 1, Number(named[3])).getTime();
    if (Number.isFinite(time)) return time;
  }
  try {
    const stat = statSync(documentPath);
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  } catch {
    return null;
  }
}

/** Lockfiles and planning documents are never compared: they are rewritten wholesale or are never landed as code. */
function isComparedFile(file: string, generated: ReadonlySet<string>): boolean {
  if (generated.has(file)) return false;
  const name = path.posix.basename(file);
  if (/^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$/i.test(name)) return false;
  if (/\.md$/i.test(name) && (/^docs\/(plans|specs|superpowers)\//.test(file)
    || /_(plan|spec|spec_planned|livetest|history|completed)(_[a-z]+)*\.md$/i.test(name))) return false;
  return true;
}

/** Paths as they are: unquoted (non-ASCII names) and never read as patterns (`*` or `[` in a name). */
const LITERAL_PATHS = ['-c', 'core.quotePath=false', '--literal-pathspecs'];
/** A queue checkpoint that reached the base branch through a hand merge is the queue's own work, not a direct change. */
const CHECKPOINT_SUBJECT = 'Plan queue checkpoint';

const RECORD = '\x1e';
const FIELD = '\x1f';

/**
 * Direct changes on `ref` after `sinceMs` that touch any of `files`, newest first. Merge commits are left out: a hand
 * merge of a branch carries no change of its own here, and its own commits are listed separately.
 */
export async function listDirectChanges(repoRoot: string, ref: string, sinceMs: number, files: readonly string[]): Promise<DirectChange[]> {
  if (!files.length) return [];
  const since = Math.floor(sinceMs / 1000);
  const output = await gitExec([...LITERAL_PATHS, 'log', '--no-merges', '--no-renames', `--since=@${since}`,
    `--format=${RECORD}%H${FIELD}%cI${FIELD}%s${FIELD}%b${FIELD}`, '--name-only', ref, '--', ...files], repoRoot, 60_000);
  const wanted = new Set(files);
  const changes: DirectChange[] = [];
  for (const record of output.split(RECORD)) {
    const [commit, date, subject, body, names] = record.split(FIELD);
    if (!commit || !date || body === undefined) continue;
    if (QUEUE_LANDING_LINE.test(body) || subject?.startsWith(CHECKPOINT_SUBJECT)) continue;
    const touched = (names ?? '').split('\n').map(name => name.trim()).filter(name => wanted.has(name));
    if (touched.length) changes.push({ commit: commit.trim(), date, subject: subject ?? '', files: touched });
  }
  return changes;
}

interface FileSides { added: Set<string>; removed: Set<string> }

/** Each file's added and removed lines in a unified diff, distinct, blank lines skipped. */
export function diffSides(diff: string): Map<string, FileSides> {
  const files = new Map<string, FileSides>();
  let current: FileSides | null = null;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const name = / b\/(.+)$/.exec(line)?.[1];
      current = name ? { added: new Set<string>(), removed: new Set<string>() } : null;
      inHunk = false;
      if (name && current) files.set(name, current);
      continue;
    }
    if (!current) continue;
    // `---`/`+++` are file headers only before a file's first hunk; inside one they are content (`-- a comment`).
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    const text = line.slice(1);
    if (!text.trim()) continue;
    if (line.startsWith('+')) current.added.add(text);
    else if (line.startsWith('-')) current.removed.add(text);
  }
  return files;
}

/** The sides of a one-file diff, without reading the name back from its header (a path may contain " b/"). */
function onlyFile(diff: string): FileSides | undefined {
  return diffSides(diff).values().next().value;
}

/**
 * Stable across `main` moving: the commit, the file and the exact lines involved, nothing about the job's branch head.
 * 16 hex characters, so a batch fits the queue's event record.
 */
export function undoFingerprint(commit: string, file: string, removedLines: readonly string[], restoredLines: readonly string[]): string {
  const payload = JSON.stringify([commit, file, [...removedLines].sort(), [...restoredLines].sort()]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * True when the job both removes lines a change added and adds back lines it removed, at least `UNDO_LINE_THRESHOLD`
 * of each (or all of them, when the change had fewer). A change that only deleted lines is undone by putting back
 * `UNDO_LINE_THRESHOLD` of them. A change that only added lines is not checked: over the 140 landings from 5 to 17 Nov,
 * removing such lines flagged 29 landings of ordinary edits, while the rule here flagged the 3 real reversals and 1 more.
 */
function undoes(change: FileSides, removedLines: number, restoredLines: number): boolean {
  if (change.added.size === 0) return restoredLines >= UNDO_LINE_THRESHOLD;
  if (removedLines === 0 || restoredLines === 0) return false;
  return removedLines >= Math.min(UNDO_LINE_THRESHOLD, change.added.size)
    && restoredLines >= Math.min(UNDO_LINE_THRESHOLD, change.removed.size);
}

/**
 * The direct changes newer than `sinceMs` that the job's work (`baseTip...head`) would undo, file by file. `baseTip`
 * is the base branch the landing would go onto; `head` is the job's branch with that base merged in.
 */
export async function findUndoneDirectChanges(repoRoot: string, baseTip: string, head: string, sinceMs: number): Promise<UndoneDirectChange[]> {
  const generated = (await loadGeneratedFiles(repoRoot, baseTip, head))?.artifacts ?? new Set<string>();
  const changedFiles = (await gitExec([...LITERAL_PATHS, 'diff', '--no-renames', '--name-only', `${baseTip}...${head}`], repoRoot, 60_000))
    .split('\n').map(name => name.trim()).filter(name => name && isComparedFile(name, generated));
  if (!changedFiles.length) return [];
  const changes = await listDirectChanges(repoRoot, baseTip, sinceMs, changedFiles);
  if (!changes.length) return [];
  // One file at a time, and only files a direct change touched: a whole landing's diff can pass git's output limit.
  const job = new Map<string, FileSides>();
  for (const file of new Set(changes.flatMap(change => change.files))) {
    const sides = onlyFile(await gitExec([...LITERAL_PATHS, 'diff', '--no-renames', '--no-color', '--no-ext-diff', `${baseTip}...${head}`, '--', file], repoRoot, 60_000));
    if (sides) job.set(file, sides);
  }
  const found: UndoneDirectChange[] = [];
  for (const change of changes) {
    for (const file of change.files) {
      const jobSides = job.get(file);
      if (!jobSides) continue;
      const changeSides = onlyFile(await gitExec([...LITERAL_PATHS, 'show', '--no-renames', '--no-color', '--no-ext-diff', '--format=', change.commit, '--', file], repoRoot, 60_000));
      if (!changeSides) continue;
      const removedLines = [...jobSides.removed].filter(line => changeSides.added.has(line));
      const restoredLines = [...jobSides.added].filter(line => changeSides.removed.has(line));
      if (!undoes(changeSides, removedLines.length, restoredLines.length)) continue;
      found.push({ commit: change.commit, date: change.date, subject: change.subject, file, removedLines, restoredLines,
        fingerprint: undoFingerprint(change.commit, file, removedLines, restoredLines) });
    }
  }
  return found;
}

/** "10 Nov 2026". */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The park note for a job that would undo direct changes. James reads it on the page and phone, and Resume hands it to
 * the next worker, so it says what each answer does in words for both.
 */
export function undoneDirectChangeNote(found: readonly UndoneDirectChange[], baseBranch: string): string {
  const byCommit = new Map<string, UndoneDirectChange[]>();
  for (const entry of found) byCommit.set(entry.commit, [...(byCommit.get(entry.commit) ?? []), entry]);
  const described = [...byCommit.values()].map(entries => {
    const first = entries[0]!;
    const names = entries.map(entry => path.posix.basename(entry.file)).join(', ');
    return `on ${shortDate(first.date)} ("${first.subject}") in ${names}`;
  });
  return `Not landed: this job would undo ${described.length === 1 ? 'a change' : 'changes'} made directly on ${baseBranch} ${described.join('; and ')}. `
    + 'Keep that change (Resume): the worker puts back what that commit did in those files, and the landing checks again. '
    + 'Or take the job\'s version (Merge without checks), on the Plan Queue page or the phone; no session can choose that.';
}

/** Backticked file names in plan text: `a/b.ts`, `b.ts:12-40`, `shell.component.*`. */
const NAMED_FILE_RE = /`([\w@./*-]+\.(?:[a-z]{1,6}|\*))(?::[\d,-]+)?`/gi;
/** The most plan-named files resolved for one prompt. */
const NAMED_FILE_LIMIT = 200;

/**
 * Tracked files the text names, by repository path, path suffix, base name, or base-name prefix ending in `*`. Exact
 * names are looked up by base name, so a plan with a thousand names over a large repository stays fast.
 */
export function filesNamedIn(text: string, tracked: readonly string[]): string[] {
  const tokens = new Set([...text.matchAll(NAMED_FILE_RE)].map(match => match[1]!.replace(/^\.?\//, '')));
  const byName = new Map<string, string[]>();
  for (const file of tracked) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const same = byName.get(name);
    if (same) same.push(file); else byName.set(name, [file]);
  }
  const found = new Set<string>();
  for (const token of tokens) {
    const name = token.slice(token.lastIndexOf('/') + 1);
    const candidates = token.endsWith('*')
      ? [...byName.entries()].filter(([candidate]) => candidate.startsWith(name.slice(0, -1))).flatMap(([, files]) => files)
      : byName.get(name) ?? [];
    for (const file of candidates) {
      const hit = token.includes('/') ? file === token || file.endsWith(`/${token}`) || (token.endsWith('*') && file.includes(token.slice(0, -1))) : true;
      if (hit) found.add(file);
      if (found.size >= NAMED_FILE_LIMIT) return [...found];
    }
  }
  return [...found];
}

export interface DirectChangesQuery {
  repoRoot: string;
  baseBranch: string;
  sinceMs: number;
  /** The job's checkout, when it has one: the files it has changed so far count. */
  worktreePath?: string | null;
  /** Plan text whose backticked file names count (the job's step, or the whole plan). */
  planText?: string;
}

/**
 * The direct changes an agent must keep: on the base branch after the plan's date, touching a file the job has changed
 * so far or its plan text names. Rebuilt every time a prompt is built, because direct changes land while a job runs.
 */
export async function directChangesForJob(query: DirectChangesQuery): Promise<DirectChange[]> {
  const ref = `refs/heads/${query.baseBranch}`;
  const files = new Set<string>();
  if (query.worktreePath) {
    const changed = await gitExec([...LITERAL_PATHS, 'diff', '--no-renames', '--name-only', `${ref}...HEAD`], query.worktreePath, 60_000);
    for (const file of changed.split('\n')) if (file.trim()) files.add(file.trim());
  }
  if (query.planText) {
    const tracked = (await gitExec([...LITERAL_PATHS, 'ls-files'], query.repoRoot, 60_000)).split('\n').filter(Boolean);
    for (const file of filesNamedIn(query.planText, tracked)) files.add(file);
  }
  const generated = (await loadGeneratedFiles(query.repoRoot, ref, ref))?.artifacts ?? new Set<string>();
  return listDirectChanges(query.repoRoot, ref, query.sinceMs, [...files].filter(file => isComparedFile(file, generated)));
}

/** One line per direct change for a prompt's data block, newest first, capped. Empty when there are none. */
export function directChangeLines(changes: readonly DirectChange[]): string[] {
  const shown = changes.slice(0, PROMPT_LIST_LIMIT).map(change => {
    const files = change.files.slice(0, PROMPT_FILES_PER_CHANGE).join(', ') + (change.files.length > PROMPT_FILES_PER_CHANGE ? ', …' : '');
    return `${change.commit.slice(0, 9)} ${shortDate(change.date)} "${change.subject}": ${files}`;
  });
  return changes.length > PROMPT_LIST_LIMIT ? [...shown, `(${changes.length - PROMPT_LIST_LIMIT} older ones not shown; \`git log\` lists them.)`] : shown;
}

/**
 * The plan sentences a job's checker and worker said a direct change overtook, as notes for the plan. Only a direct
 * change to this job's files can overtake its plan text, so an entry is dropped unless the sentence is in the plan and
 * its commit is on `baseRef`, newer than the plan, touches a file the landed job changed, and is neither a queue
 * landing nor a queue checkpoint (an agent copying an example hash, or naming its own checkpoint, writes nothing).
 */
export async function stalePlanNotesFor(item: Pick<PlanQueueItem, 'verdict' | 'workerReport' | 'sourceRef' | 'landedCommit'>, repoRoot: string, baseRef: string, sinceMs: number): Promise<StalePlanNote[]> {
  const entries = [...(item.verdict?.stalePlanText ?? []), ...(item.workerReport?.stalePlanText ?? [])];
  if (!entries.length || !item.landedCommit) return [];
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  const plan = flat(await readFile(item.sourceRef, 'utf8'));
  const namesIn = async (commit: string) => new Set((await gitExec([...LITERAL_PATHS, 'show', '--no-renames', '--name-only', '--format=', commit], repoRoot)).split('\n').filter(Boolean));
  const jobFiles = await namesIn(item.landedCommit);
  const seen = new Set<string>();
  const notes: StalePlanNote[] = [];
  for (const entry of entries) {
    const key = `${entry.commit}\n${entry.sentence.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The schema allows only a hash; a stored verdict is read back unchecked, so never hand git anything else.
    if (!/^[0-9a-f]{7,40}$/i.test(entry.commit) || !plan.includes(flat(entry.sentence))) continue;
    const shown = await gitExec(['log', '-1', `--format=%H${FIELD}%cI${FIELD}%s${FIELD}%B`, '--end-of-options', entry.commit, '--'], repoRoot).catch(() => '');
    const [commit, date, subject, body] = shown.split(FIELD);
    if (!commit || !date || body === undefined || QUEUE_LANDING_LINE.test(body) || subject?.startsWith(CHECKPOINT_SUBJECT)) continue;
    if (new Date(date).getTime() < sinceMs) continue;
    if (!await gitExec(['merge-base', '--is-ancestor', commit, baseRef], repoRoot).then(() => true, () => false)) continue;
    if (![...await namesIn(commit)].some(file => jobFiles.has(file))) continue;
    notes.push({ commit, date: shortDate(date), step: entry.step ?? null, sentence: entry.sentence });
  }
  return notes;
}

/** Why anyone but James (the Plan Queue page or the phone, both caller-less) is refused Land anyway for a job that undoes a direct change. */
export const UNDO_DIRECT_CHANGE_REFUSAL = 'This job would undo a change made directly on the base branch. Only James can take the job\'s version, on the Plan Queue page or the phone; Resume keeps the change instead.';

/** When the job's plan was written, for this item: a ticket has no plan file, and no job is older than its plan. */
export function itemReferenceTime(item: Pick<PlanQueueItem, 'sourceKind' | 'sourceRef' | 'createdAt'>): number {
  return (item.sourceKind ?? 'markdown') === 'markdown' ? planReferenceTime(item.sourceRef) ?? item.createdAt : item.createdAt;
}

/**
 * The direct changes a prompt for this job lists: files its branch has changed so far, plus files its step (or, for a
 * whole-document job, its plan) names. The list only advises; landing enforces it (`findUndoneDirectChanges`), so a git
 * failure here is logged and the prompt goes out without the list rather than stopping the job.
 */
export async function directChangesForItem(run: Pick<PlanQueueRun, 'workspaceCwd' | 'config'>, item: PlanQueueItem): Promise<DirectChange[]> {
  const baseBranch = run.config.baseBranch;
  if (!baseBranch) return [];
  try {
    let planText: string | undefined;
    if ((item.sourceKind ?? 'markdown') === 'markdown') {
      const text = await readFile(item.sourceRef, 'utf8');
      const step = item.section == null ? undefined : planSteps(text)?.find(candidate => candidate.number === item.section);
      planText = step ? text.split('\n').slice(step.startLine - 1, step.endLine).join('\n') : text;
    }
    const worktreePath = item.worktreePath && await hasCheckout(item.worktreePath) ? item.worktreePath : null;
    return await directChangesForJob({ repoRoot: run.workspaceCwd, baseBranch, sinceMs: itemReferenceTime(item), worktreePath, planText });
  } catch (error) {
    logger.warn('Plan queue: the direct-change list for a prompt could not be built', { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

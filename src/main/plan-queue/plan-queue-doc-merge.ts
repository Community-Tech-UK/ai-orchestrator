/** Read-only merge preparation, then durable backups before any root checkout write. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { getLogger } from '../logging/logger';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { gitExec, gitExecSafe } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { readGitStatusPaths } from '../workspace/git/git-status-stream';
import type { DirtyOverlapInput, DirtyOverlapResolver } from '../workspace/git/dirty-overlap.types';
import { GENERATED_STATUSES, loadGeneratedFiles, regenerateGeneratedFiles, type GeneratedFiles } from './plan-queue-generated-files';
import type { PlanQueueStore } from './plan-queue-store';

const logger = getLogger('PlanQueueDocMerge');
const LIVETEST_REGISTER_PATH = 'docs/plans/livetest-remediation-register.md';
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  version: z.literal(1), itemId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), repoRoot: z.string(),
  baseTip: z.string().regex(/^[a-f0-9]{40,64}$/), integrationTip: z.string().regex(/^[a-f0-9]{40,64}$/),
  entries: z.array(z.object({
    path: z.string(), index: z.number().int().nonnegative(),
    // A backup written before generated files were handled has no kind: it is a document.
    kind: z.enum(['document', 'code', 'generated']).default('document'),
    status: z.enum([' M', '??', 'M ', 'MM']),
    oursHash: hashSchema, baseHash: hashSchema.nullable(), theirsHash: hashSchema, mergedHash: hashSchema,
  })).min(1),
});
type Manifest = z.infer<typeof ManifestSchema>;
type Entry = Manifest['entries'][number];
interface PreparedFile { entry: Entry; ours: Buffer; merged: Buffer }
/** Git pathspecs are globs, and `app/[id]/page.tsx` would also match `app/i/page.tsx`. */
const literal = (file: string) => `:(literal)${file}`;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
function readable(file: string, bytes: Buffer): void {
  try { if (!text(bytes).includes('\0')) return; } catch { /* not UTF-8 */ }
  throw new Error(`Couldn't merge ${file}: it isn't a text file.`);
}

/** Binary stdout is intentional: gitExec trims, and document bytes must survive unchanged. */
function gitBytes(args: string[], cwd: string): Promise<{ code: number; output: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: hermeticGitEnv(), encoding: 'buffer', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(new Error('The document merge git command could not run.'));
      else resolve({ code: error?.code as number ?? 0, output: Buffer.from(stdout) });
    });
  });
}

async function version(repoRoot: string, tip: string, file: string): Promise<Buffer | null> {
  const result = await gitBytes(['show', `${tip}:${file}`], repoRoot);
  return result.code === 0 ? result.output : null;
}

type EntryKind = Entry['kind'];

/** Only a `document` has to be Markdown. */
async function safeRootPath(repoRoot: string, file: string, kind: EntryKind): Promise<string> {
  if (!file || path.isAbsolute(file) || file.includes('\0') || file.split(/[\\/]/).some((part) => part === '..') || (kind === 'document' && !/\.md$/i.test(file))) {
    throw new Error(`Refusing unsafe document path ${file}.`);
  }
  const full = path.resolve(repoRoot, file);
  const parent = await fs.realpath(path.dirname(full));
  const relative = path.relative(repoRoot, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Refusing document outside the checkout: ${file}.`);
  const stat = await fs.lstat(full).catch(() => null);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Refusing non-regular document ${file}.`);
  return full;
}

async function currentHash(repoRoot: string, file: string, kind: EntryKind): Promise<string | null> {
  const full = await safeRootPath(repoRoot, file, kind);
  return fs.readFile(full).then(hash, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function addedKeys(diff: string): Set<string> {
  const keys = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    const heading = added.match(/^#{1,6}\s+(.+?)\s*#*$/);
    const cell = added.match(/^\|\s*([^|]+?)\s*\|/);
    const value = heading?.[1] ?? cell?.[1];
    if (value) keys.add(value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').trim());
  }
  return keys;
}

/** Every diff3 conflict must be an insertion with an empty ancestor section. */
function insertionConflictsOnly(merged: string): boolean {
  const lines = merged.split('\n');
  let conflicts = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<'.repeat(40))) continue;
    conflicts++;
    while (++i < lines.length && !lines[i].startsWith('|'.repeat(40))) { /* ours */ }
    if (i >= lines.length) return false;
    const base: string[] = [];
    while (++i < lines.length && lines[i] !== '='.repeat(40)) base.push(lines[i]);
    if (i >= lines.length || base.length !== 0) return false;
    while (++i < lines.length && !lines[i].startsWith('>'.repeat(40))) { /* theirs */ }
    if (i >= lines.length) return false;
  }
  return conflicts > 0;
}

/** Documents may combine insertions at the same place. Two blocks of code side by side aren't known to work, so code must merge cleanly. */
async function mergeVersions(repoRoot: string, file: string, kind: EntryKind, ours: Buffer, base: Buffer, theirs: Buffer): Promise<Buffer> {
  const temp = await fs.mkdtemp(path.join(tmpdir(), 'aio-doc-merge-'));
  try {
    const oursPath = path.join(temp, 'ours'); const basePath = path.join(temp, 'base'); const theirsPath = path.join(temp, 'theirs');
    await fs.writeFile(oursPath, ours); await fs.writeFile(basePath, base); await fs.writeFile(theirsPath, theirs);
    const first = await gitBytes(['merge-file', '-p', '--diff3', '--marker-size=40', oursPath, basePath, theirsPath], repoRoot);
    if (first.code === 0) return first.output;
    if (kind !== 'document' || first.code < 1 || first.code > 127 || !insertionConflictsOnly(text(first.output))) throw new Error(`You and the item changed the same lines of ${file}.`);
    const ourDiff = await gitBytes(['diff', '--no-index', '--unified=0', '--', basePath, oursPath], repoRoot);
    const theirDiff = await gitBytes(['diff', '--no-index', '--unified=0', '--', basePath, theirsPath], repoRoot);
    if (ourDiff.code > 1 || theirDiff.code > 1) throw new Error(`Could not compare insertions in ${file}.`);
    const oursAdded = addedKeys(text(ourDiff.output)); const theirsAdded = addedKeys(text(theirDiff.output));
    const duplicate = [...oursAdded].find((key) => theirsAdded.has(key));
    if (duplicate) throw new Error(`You and the item added the same table id or heading (${duplicate}) in ${file}.`);
    const union = await gitBytes(['merge-file', '-p', '--union', oursPath, basePath, theirsPath], repoRoot);
    if (union.code !== 0) throw new Error(`Could not merge insertions in ${file}.`);
    return union.output;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

/** What a line records: every id in an index row's first cell, or a section's id. A row and a section are separate entries. */
function lineEntries(line: string): string[] {
  const row = /^\|([^|]*)\|/.exec(line)?.[1];
  if (row !== undefined) return [...row.matchAll(/LT-\d+/g)].map(id => `|${id[0]}`);
  const section = /^##\s*(LT-\d+)\b/.exec(line)?.[1];
  return section ? [`##${section}`] : [];
}

function registerEntries(lines: readonly string[]): Map<string, string> {
  return new Map(lines.flatMap(line => lineEntries(line).map(entry => [entry, line] as const)));
}

interface OwnedLine { line: string; owners: string[] }

/** Each line with the entries it belongs to: its own, or the section it sits in, when that section's heading is in the same clash. */
function ownedLines(lines: readonly string[]): OwnedLine[] {
  let section: string[] = [];
  return lines.map(line => {
    if (/^##\s/.test(line)) section = lineEntries(line);
    const own = lineEntries(line);
    return { line, owners: own.length ? own : section };
  });
}

/** True when taking main's side of a clash loses nothing only the job did: every line it added or removed belongs to an entry main changed too. */
function mainAnswersJob(job: readonly string[], base: readonly string[], main: readonly string[]): boolean {
  const jobEntries = registerEntries(job), baseEntries = registerEntries(base), mainEntries = registerEntries(main);
  if ([...baseEntries.keys()].some(entry => !jobEntries.has(entry))) return false;
  const answered = ({ owners }: OwnedLine) => owners.length > 0
    && owners.every(entry => mainEntries.has(entry) && mainEntries.get(entry) !== baseEntries.get(entry));
  const added = ownedLines(job).filter(({ line }) => !base.includes(line) && !main.includes(line));
  const removed = ownedLines(base).filter(({ line }) => !job.includes(line));
  return added.every(answered) && removed.every(change => answered(change) && !main.includes(change.line));
}

function doubledEntries(register: string): Set<string> {
  const seen = new Set<string>();
  const doubled = new Set<string>();
  for (const line of register.split('\n')) {
    for (const entry of lineEntries(line)) (seen.has(entry) ? doubled : seen).add(entry);
  }
  return doubled;
}

/**
 * Settle each clash in a three-way merge of the live-test register: `merged` has the job's lines first and main's last.
 * Two sets of new lines are both kept. Where both sides changed the same entries main's copy stays, along with its text
 * for a section both added or changed: in every clash replayed on 6 November 2026 that was one defect recorded twice, and main's
 * copy was the newer. Null when anything else in a clash would be lost, so a person or worker decides.
 */
export function settleRegisterClashes(merged: string): { text: string; replaced: string[] } | null {
  const lines = merged.split('\n');
  const settled: string[] = [];
  const replaced: string[] = [];
  const until = (start: number, marker: string) => {
    let end = start;
    while (end < lines.length && !lines[end].startsWith(marker.repeat(40))) end++;
    return end;
  };
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('<'.repeat(40))) { settled.push(lines[index]); continue; }
    const baseAt = until(index + 1, '|'), mainAt = until(baseAt + 1, '='), endAt = until(mainAt + 1, '>');
    const job = lines.slice(index + 1, baseAt), main = lines.slice(mainAt + 1, endAt);
    const base = lines.slice(baseAt + 1, mainAt);
    const jobEntries = registerEntries(job), mainEntries = registerEntries(main);
    index = endAt;
    if (!base.length && ![...jobEntries.keys()].some(entry => mainEntries.has(entry))) {
      // A new section goes last, or the other side's lines would read as part of it.
      settled.push(...(job.find(Boolean)?.startsWith('## ') ? [...main, ...job] : [...job, ...main]));
      continue;
    }
    if (!mainAnswersJob(job, base, main)) return null;
    settled.push(...main);
    replaced.push(...jobEntries.keys());
  }
  return { text: settled.join('\n'), replaced };
}

/**
 * Finish a merge of main into a job's branch whose only clash is the live-test register, so a passed job isn't held up
 * by a list every job adds to. A rule in `.gitattributes` can't do this: committed on main, it doesn't apply when merging
 * into an older branch. Caller owns the Git write queue. False leaves the merge in place for whoever resolves it.
 */
export async function resolveRegisterClash(worktreePath: string, conflictFiles: readonly string[]): Promise<boolean> {
  if (conflictFiles.length !== 1 || conflictFiles[0] !== LIVETEST_REGISTER_PATH) return false;
  const stage = (number: number) => `:${number}:${LIVETEST_REGISTER_PATH}`;
  try {
    const clash = await gitBytes(['merge-file', '-p', '--diff3', '--marker-size=40', '--object-id', stage(2), stage(1), stage(3)], worktreePath);
    if (clash.code < 0 || clash.code > 127) return false;
    const result = settleRegisterClashes(clash.output.toString('utf8'));
    if (!result) return false;
    // An entry each side put in a different place merges without a clash, and would be listed twice.
    const onMain = doubledEntries((await gitBytes(['show', stage(3)], worktreePath)).output.toString('utf8'));
    if ([...doubledEntries(result.text)].some(entry => !onMain.has(entry))) return false;
    await fs.writeFile(path.join(worktreePath, LIVETEST_REGISTER_PATH), result.text);
    await gitExec(['add', '--', LIVETEST_REGISTER_PATH], worktreePath);
    await gitExec(['commit', '--no-verify', '--no-gpg-sign', '--no-edit'], worktreePath);
    // The branch goes after landing, so this line is what's left of the job's copy.
    if (result.replaced.length) logger.warn('Plan queue kept the base branch\'s register entries', { worktreePath, replaced: result.replaced });
    return true;
  } catch (error) {
    logger.warn('Plan queue could not settle a register clash', { worktreePath, error: error instanceof Error ? error.message : String(error) });
    // Put the clash back as Git made it, so nobody commits a half-settled file. If that fails too, the merge stays unfinished.
    await gitExec(['checkout', '-m', '--', literal(LIVETEST_REGISTER_PATH)], worktreePath).catch((restore: unknown) => {
      logger.warn('Plan queue could not restore a register clash', { worktreePath, error: restore instanceof Error ? restore.message : String(restore) });
    });
    return false;
  }
}

async function durableWrite(file: string, bytes: Buffer | string): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function backupRoot(repoRoot: string): Promise<string> {
  const common = await gitExec(['rev-parse', '--git-common-dir'], repoRoot);
  return path.join(path.resolve(repoRoot, common), 'aio-plan-queue', 'doc-merge');
}

/** A generated file may legitimately be staged (the hook stages it); anything else staged is a conflict. */
async function assertRootState(repoRoot: string, file: string, expected: (string | null)[], head: string, backup: string, operation: string, kind: EntryKind): Promise<void> {
  if (await gitExec(['rev-parse', 'HEAD'], repoRoot) !== head) throw new Error(`HEAD changed during ${operation}; backup kept at ${backup}.`);
  if (kind !== 'generated' && !await gitExec(['diff', '--cached', '--quiet', '--', literal(file)], repoRoot).then(() => true, () => false)) {
    throw new Error(`Document staged during ${operation}: ${file}; backup kept at ${backup}.`);
  }
  if (!expected.includes(await currentHash(repoRoot, file, kind))) throw new Error(`Document changed during ${operation}: ${file}; backup kept at ${backup}.`);
}

async function writeRoot(repoRoot: string, file: string, bytes: Buffer, expected: (string | null)[], head: string, backup: string, operation: string, kind: EntryKind): Promise<void> {
  const full = await safeRootPath(repoRoot, file, kind);
  // Recheck after every awaited preparation step, immediately before this file's write.
  // External editors do not share the Git queue; this narrows, rather than eliminates, the OS write window.
  await assertRootState(repoRoot, file, expected, head, backup, operation, kind);
  const handle = await fs.open(full, 'w');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (hash(await fs.readFile(full)) !== hash(bytes)) throw new Error(`Could not verify restored document ${file}.`);
}

const isGenerated = (entry: Entry) => entry.kind === 'generated';
const isStaged = (entry: Entry) => entry.status[0] === 'M';

/**
 * A file the repository's hook regenerates: its root copy is derived data, so it is backed up, set
 * aside and replaced by the landing's copy, then rebuilt. Staged and unstaged copies are both accepted.
 */
async function prepareGenerated(repoRoot: string, input: DirtyOverlapInput, overlap: { path: string; status: string }, index: number): Promise<PreparedFile> {
  if (!GENERATED_STATUSES.includes(overlap.status)) throw new Error(`Couldn't merge ${overlap.path}: added, deleted, renamed or conflicted changes to a generated file must be resolved first.`);
  const ours = await fs.readFile(await safeRootPath(repoRoot, overlap.path, 'generated'));
  const base = await version(repoRoot, input.baseTip, overlap.path);
  const theirs = await version(repoRoot, input.integrationTip, overlap.path);
  if (!theirs) throw new Error(`Couldn't merge ${overlap.path}: the item deletes this generated file.`);
  return { ours, merged: theirs, entry: { path: overlap.path, kind: 'generated', status: overlap.status as Entry['status'], index,
    oursHash: hash(ours), baseHash: base ? hash(base) : null, theirsHash: hash(theirs), mergedHash: hash(theirs) } };
}

async function permissionsDiffer(repoRoot: string, full: string, overlap: { path: string; status: string }): Promise<boolean> {
  // Git isn't tracking permissions here, so neither should this.
  if (await gitExecSafe(['config', '--type=bool', 'core.fileMode'], repoRoot) === 'false') return false;
  const executable = ((await fs.stat(full)).mode & 0o100) !== 0;
  if (overlap.status === '??') return executable;
  return executable !== (await gitExec(['ls-files', '--stage', '--', literal(overlap.path)], repoRoot)).startsWith('100755');
}

export function createDocumentOverlapResolver(options: { itemId: string }): DirtyOverlapResolver {
  return { prepare: (input) => prepareDocuments(input, options.itemId) };
}

async function prepareDocuments(input: DirtyOverlapInput, itemId: string) {
  const repoRoot = await fs.realpath(input.repoRoot);
  let backup: string | null = null;
  let resetStarted = false;
  const files: PreparedFile[] = [];
  try {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(itemId)) throw new Error('The item id is not safe for a document backup.');
    let generated: GeneratedFiles | null | undefined;
    for (const overlap of input.overlaps) {
      const kind = /\.md$/i.test(overlap.path) ? 'document' : 'code';
      if (kind === 'code') {
        // Every refusal happens in this read-only loop, before anything is backed up or moved.
        if (generated === undefined) generated = await loadGeneratedFiles(repoRoot, input.baseTip, input.integrationTip);
        if (generated?.artifacts.has(overlap.path)) {
          files.push(await prepareGenerated(repoRoot, input, overlap, files.length));
          continue;
        }
      }
      if (overlap.status !== ' M' && overlap.status !== '??') throw new Error(`Couldn't merge ${overlap.path}: staged, deleted, renamed or conflicted changes must be resolved first.`);
      const full = await safeRootPath(repoRoot, overlap.path, kind);
      // The backup holds bytes, not permissions, so a permission edit can't be put back.
      if (await permissionsDiffer(repoRoot, full, overlap)) throw new Error(`Couldn't merge ${overlap.path}: its file permissions have uncommitted changes.`);
      const ours = await fs.readFile(full); readable(overlap.path, ours);
      const base = await version(repoRoot, input.baseTip, overlap.path);
      const theirs = await version(repoRoot, input.integrationTip, overlap.path);
      if (!theirs) throw new Error(`Couldn't merge ${overlap.path}: the item deletes the file.`);
      readable(overlap.path, theirs); if (base) readable(overlap.path, base);
      let merged: Buffer;
      if (overlap.status === '??') {
        if (!ours.equals(theirs)) throw new Error(`Couldn't merge ${overlap.path}: your untracked file differs from the item's copy.`);
        merged = theirs;
      } else {
        if (!base) throw new Error(`Couldn't merge ${overlap.path}: no base version is available.`);
        merged = await mergeVersions(repoRoot, overlap.path, kind, ours, base, theirs);
      }
      files.push({ ours, merged, entry: { path: overlap.path, kind, status: overlap.status, index: files.length,
        oursHash: hash(ours), baseHash: base ? hash(base) : null, theirsHash: hash(theirs), mergedHash: hash(merged) } });
    }
    const root = await backupRoot(repoRoot); await fs.mkdir(root, { recursive: true });
    const candidate = path.join(root, itemId); await fs.mkdir(candidate); // An unfinished backup is never overwritten.
    backup = candidate;
    for (const file of files) {
      await durableWrite(path.join(backup, `ours-${file.entry.index}`), file.ours);
      await durableWrite(path.join(backup, `merged-${file.entry.index}`), file.merged);
    }
    const manifest: Manifest = { version: 1, itemId, repoRoot, baseTip: input.baseTip, integrationTip: input.integrationTip, entries: files.map((file) => file.entry) };
    await durableWrite(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
    await syncDirectory(backup); await syncDirectory(root);
    for (const file of files) {
      if (await currentHash(repoRoot, file.entry.path, file.entry.kind) !== file.entry.oursHash) throw new Error(`Couldn't merge ${file.entry.path}: it changed while Harness checked it; your edits were left untouched.`);
    }
    if (await gitExec(['rev-parse', 'HEAD'], repoRoot) !== input.baseTip) throw new Error('The base checkout moved while documents were being prepared.');
    const statuses = new Map<string, string | undefined>(
      files.map((file) => [file.entry.path, undefined]),
    );
    await readGitStatusPaths(repoRoot, (file, status) => {
      if (statuses.has(file)) statuses.set(file, status);
    });
    for (const file of files) {
      if (statuses.get(file.entry.path) !== file.entry.status) throw new Error(`Couldn't merge ${file.entry.path}: its status changed while Harness checked it; resolve staged or moved files first.`);
      if (await currentHash(repoRoot, file.entry.path, file.entry.kind) !== file.entry.oursHash) throw new Error(`Couldn't merge ${file.entry.path}: it changed while Harness checked it; your edits were left untouched.`);
    }
    for (const file of files) {
      const full = await safeRootPath(repoRoot, file.entry.path, file.entry.kind);
      await assertRootState(repoRoot, file.entry.path, [file.entry.oursHash], input.baseTip, backup, 'document reset', file.entry.kind);
      resetStarted = true;
      if (file.entry.status === '??') await fs.rename(full, path.join(backup, `aside-${file.entry.index}`));
      else if (isGenerated(file.entry)) await gitExec(['checkout', 'HEAD', '--', literal(file.entry.path)], repoRoot); // index and working copy together
      else await gitExec(['checkout', '--', literal(file.entry.path)], repoRoot);
    }
    const heldBackup = backup;
    const generatorScripts = files.some((file) => isGenerated(file.entry)) ? generated?.generators : undefined;
    return {
      ok: true as const,
      finish: async () => {
        // A generated file needs no write: the fast-forward already put the landing's copy there.
        for (const file of files.filter((candidate) => !isGenerated(candidate.entry))) {
          await writeRoot(repoRoot, file.entry.path, file.merged, [file.entry.theirsHash], input.integrationTip, heldBackup, 'promotion', file.entry.kind);
        }
        for (const file of files) {
          await assertRootState(repoRoot, file.entry.path, [file.entry.mergedHash], input.integrationTip, heldBackup, 'promotion verification', file.entry.kind);
        }
        if (generatorScripts) await regenerateGeneratedFiles(repoRoot, generatorScripts);
        await fs.rm(heldBackup, { recursive: true });
        return files.filter((file) => !isGenerated(file.entry) && file.entry.mergedHash !== file.entry.theirsHash).map((file) => file.entry.path);
      },
      undo: async () => {
        for (const file of files) {
          await writeRoot(repoRoot, file.entry.path, file.ours, [file.entry.baseHash, file.entry.oursHash], input.baseTip, heldBackup, 'rollback', file.entry.kind);
          if (isGenerated(file.entry) && isStaged(file.entry)) await gitExec(['add', '--', literal(file.entry.path)], repoRoot);
        }
        for (const file of files) {
          await assertRootState(repoRoot, file.entry.path, [file.entry.oursHash], input.baseTip, heldBackup, 'rollback verification', file.entry.kind);
        }
        await fs.rm(heldBackup, { recursive: true });
      },
    };
  } catch (error) {
    if (backup && !resetStarted) await fs.rm(backup, { recursive: true, force: true });
    // A partially completed reset is recovered using the durable manifest; never overwrite later edits here.
    return { ok: false as const, reason: (error instanceof Error ? error.message : 'Document merge preparation failed.')
      + (backup && resetStarted ? ` Harness kept a copy of your edits at ${backup}.` : '') };
  }
}

interface ReconciledBackup { pending: string[]; mergedPaths: string[] }

/** Caller owns the Git write queue. Reuse for boot recovery and an individual retry. */
async function reconcileBackup(manifest: Manifest, backup: string): Promise<ReconciledBackup> {
  const { repoRoot } = manifest;
  const pending: string[] = [];
  const mergedPaths: string[] = [];
  const head = await gitExec(['rev-parse', 'HEAD'], repoRoot);
  const advanced = await gitExec(['merge-base', '--is-ancestor', manifest.integrationTip, head], repoRoot).then(() => true, () => false);
  for (const entry of manifest.entries) {
    const generated = isGenerated(entry);
    try {
      const current = await currentHash(repoRoot, entry.path, entry.kind);
      if (generated && advanced) {
        // Once the landing is in, nothing of James's is left to restore: the file is derived data. A rebuild cut short
        // by a crash could leave it half-written, so put the committed copy back; the hook rebuilds it at the next commit.
        const committed = await version(repoRoot, head, entry.path);
        if (committed && current !== hash(committed)) await writeRoot(repoRoot, entry.path, committed, [current], head, backup, 'document recovery', entry.kind);
        continue;
      }
      if (advanced && current === entry.mergedHash) {
        if (entry.mergedHash !== entry.theirsHash) mergedPaths.push(entry.path);
        continue;
      }
      if (head === manifest.baseTip && current === entry.oursHash) continue;
      const headVersion = advanced ? await version(repoRoot, head, entry.path) : null;
      const target = advanced && current === entry.theirsHash && headVersion && hash(headVersion) === entry.theirsHash ? 'merged'
        : head === manifest.baseTip && current === entry.baseHash ? 'ours' : null;
      if (!target) { pending.push(entry.path); continue; }
      const bytes = await fs.readFile(path.join(backup, `${target}-${entry.index}`));
      if (hash(bytes) !== (target === 'ours' ? entry.oursHash : entry.mergedHash)) { pending.push(entry.path); continue; }
      await writeRoot(repoRoot, entry.path, bytes, [current], head, backup, 'document recovery', entry.kind);
      if (generated && isStaged(entry)) await gitExec(['add', '--', literal(entry.path)], repoRoot);
      if (target === 'merged' && entry.mergedHash !== entry.theirsHash) mergedPaths.push(entry.path);
    } catch { pending.push(entry.path); }
  }
  if (!pending.length) {
    for (const entry of manifest.entries) {
      if (isGenerated(entry) && advanced) continue;
      try { await assertRootState(repoRoot, entry.path, [advanced ? entry.mergedHash : entry.oursHash], head, backup, 'recovery verification', entry.kind); }
      catch { pending.push(entry.path); }
    }
    if (!pending.length) await fs.rm(backup, { recursive: true });
  }
  return { pending, mergedPaths };
}

async function readManifest(backup: string, repoRoot: string, itemId: string): Promise<Manifest | null> {
  const manifest = await fs.readFile(path.join(backup, 'manifest.json'), 'utf8')
    .then((content) => ManifestSchema.safeParse(JSON.parse(content)), () => null).catch(() => null);
  return manifest?.success && manifest.data.repoRoot === repoRoot && manifest.data.itemId === itemId ? manifest.data : null;
}

function keptBackupNote(backup: string, paths: string[]): string {
  return `Harness kept a copy of your edits${paths.length ? ` to ${paths.join(', ')}` : ''} at ${backup}.`;
}

/** The landing chain holds the item lock, but does not hold the Git write queue. */
export async function recoverDocumentMergeForItem(workspace: string, itemId: string): Promise<
  { ok: true; mergedPaths: string[] } | { ok: false; reason: string }
> {
  return getGitWriteQueue().enqueue('plan-queue-doc-merge-retry', async () => {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(itemId)) return { ok: false, reason: 'The item id is not safe for a document backup.' };
    const repoRoot = await fs.realpath(workspace);
    const backup = path.join(await backupRoot(repoRoot), itemId);
    const exists = await fs.lstat(backup).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (!exists) return { ok: true, mergedPaths: [] };
    const manifest = await readManifest(backup, repoRoot, itemId);
    if (!manifest) return { ok: false, reason: `${keptBackupNote(backup, [])} Its recovery manifest could not be verified.` };
    try {
      const recovered = await reconcileBackup(manifest, backup);
      if (recovered.pending.length) return { ok: false, reason: `${keptBackupNote(backup, recovered.pending)} Restore these edits before retrying landing.` };
      return { ok: true, mergedPaths: recovered.mergedPaths };
    } catch {
      return { ok: false, reason: `${keptBackupNote(backup, manifest.entries.map((entry) => entry.path))} Recovery could not finish; restore these edits before retrying landing.` };
    }
  });
}

type RecoveryStore = Pick<PlanQueueStore, 'listWorkspaceRoots' | 'getItem' | 'getRun' | 'upsertItem'>;
export async function recoverInterruptedDocumentMerges(store: RecoveryStore): Promise<void> {
  for (const workspace of store.listWorkspaceRoots()) {
    await getGitWriteQueue().enqueue('plan-queue-doc-merge-recovery', async () => {
      const repoRoot = await fs.realpath(workspace).catch(() => null);
      if (!repoRoot) return;
      const root = await backupRoot(repoRoot).catch(() => null);
      if (!root) return;
      const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const dir of dirs) {
        if (!dir.isDirectory() || !/^[a-zA-Z0-9_-]{1,200}$/.test(dir.name)) continue;
        const backup = path.join(root, dir.name);
        const manifest = await readManifest(backup, repoRoot, dir.name);
        if (!manifest) continue;
        const item = store.getItem(manifest.itemId);
        if (!item || await fs.realpath(store.getRun(item.runId)?.workspaceCwd ?? '').catch(() => null) !== repoRoot) continue;
        const recovered = await reconcileBackup(manifest, backup);
        if (recovered.pending.length) {
          const note = keptBackupNote(backup, recovered.pending);
          if (!item.detail?.includes(note)) store.upsertItem({ ...item, detail: `${item.detail ?? ''} ${note}`.trim().slice(-8000) });
        } else if (recovered.mergedPaths.length) {
          store.upsertItem({ ...item, detail: `Merged with your uncommitted edits to ${recovered.mergedPaths.join(', ')}; your edits are still uncommitted.` });
        }
      }
    });
  }
}

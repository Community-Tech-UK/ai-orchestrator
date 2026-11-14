/**
 * Planning documents on a job that runs on another computer (spec: "Out and back: the plan and other planning
 * documents"). None of this Mac's paths exist there, so the job's plan, its linked spec and the other planning
 * documents the plan points at go out at their repository paths, and the ones the agent changes come back.
 *
 * Each item keeps a record of what was sent (sha256 per path, and the bytes, so `queue.prepare` sends exactly
 * what was recorded). It is rebuilt from the main checkout's current bytes at every send, so Harness's own trim or a
 * parked note between turns becomes the new "sent" and is never mistaken for an edit by James.
 *
 * Coming back:
 *  - a document that was sent replaces the main copy only when that copy is byte for byte what was sent, through
 *    `assertDocumentFileUnchanged` and `changeDocumentFile` (which keeps the old file as a hidden `.aio-retained-`
 *    copy, as every guarded plan change does), and only when the job's bytes differ. If the main copy changed, the
 *    job's version is saved beside it and the job is held;
 *  - any other document follows `relocatePlanningFiles` exactly: created if new, never replacing, a different copy
 *    saved beside it. One the job created counts as sent from then on;
 *  - a document deleted over there is reported, never deleted here.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { QueueRelativePathSchema, type QueueDocument } from '../../remote-node/queue-job-rpc-schemas';
import { assertDocumentFileUnchanged, changeDocumentFile, documentFileIdentity } from '../plan-queue-document-mutation';
import { linkedSpecPaths } from '../plan-queue-document-review';
import { PLAN_CHANGED_HOLD_PREFIX } from '../plan-queue-state';
import { harnessDir, relocatePlanningFiles, saveBeside } from '../plan-queue-planning-files';

/** One planning document is never sent or taken back above this. */
export const MAX_PLANNING_DOCUMENT_BYTES = 2 * 1024 * 1024;
/** Most documents a plan can pull in by links (the job's own document is extra). */
const MAX_LINKED_DOCUMENTS = 40;
/** A link counts only when it points at a planning document, not at any markdown file. */
const PLANNING_DOCUMENT_NAME = /(_spec|_plan|_livetest|_history)(_planned|_completed)?\.md$|-decisions-for-james\.md$/;

export interface OutgoingDocument {
  /** Path relative to the repository, forward slashes. */
  path: string;
  bytes: Buffer;
  sha256: string;
}

/** What was sent for one item, by repository path. */
export type SentRecord = Record<string, { sha256: string; contentBase64: string }>;

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Read one planning document if it is a regular file, not a link, inside the repository, within the size limit.
 * Returns null otherwise (never throws for a missing or unsuitable file).
 */
async function readInside(realRoot: string, candidate: string): Promise<OutgoingDocument | null> {
  try {
    const folder = await fs.realpath(path.dirname(candidate));
    if (!insideRoot(realRoot, folder)) return null;
    const file = path.join(folder, path.basename(candidate));
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_PLANNING_DOCUMENT_BYTES) return null;
    const relative = path.relative(realRoot, file).split(path.sep).join('/');
    if (!QueueRelativePathSchema.safeParse(relative).success || relative.split('/').includes('.git')) return null;
    const bytes = await fs.readFile(file);
    return { path: relative, bytes, sha256: digest(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Markdown paths a plan mentions, in order, as links or bare paths; web addresses are skipped. */
function mentionedMarkdownPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/[^\s()<>[\]"'`,;|*\\]+?\.md(?![A-Za-z0-9_])/g)) {
    let token = match[0];
    if (token.includes('://')) continue;
    try { token = decodeURIComponent(token); } catch { /* keep the raw text */ }
    found.add(token);
  }
  return [...found];
}

/**
 * The documents that go out with a job: its own document (`sourceRef`, an absolute path in the root checkout), its
 * linked spec, and the other planning documents the plan links to by an absolute path under the repository or by a
 * path that exists in the root checkout (relative to the repository, or to the plan's own folder). Only existing
 * regular files, never outside the repository, never through a symlink out, size-bounded. Throws when the job's own
 * document cannot be sent (it is outside the repository, not a regular file, or too large).
 */
export async function collectOutgoingDocuments(repoRoot: string, sourceRef: string): Promise<OutgoingDocument[]> {
  const realRoot = await fs.realpath(repoRoot);
  const own = await readInside(realRoot, path.resolve(sourceRef));
  if (!own) throw new Error(`The job's document (${sourceRef}) cannot be sent: it is not a regular file inside the repository, or it is too large.`);
  const documents = new Map<string, OutgoingDocument>([[own.path, own]]);
  const planDir = path.dirname(path.resolve(sourceRef));
  const candidates: string[] = [...linkedSpecPaths(path.resolve(sourceRef))];
  for (const token of mentionedMarkdownPaths(own.bytes.toString('utf8'))) {
    if (!PLANNING_DOCUMENT_NAME.test(path.posix.basename(token))) continue;
    if (path.isAbsolute(token)) candidates.push(token);
    else if (token.startsWith('./') || token.startsWith('../')) candidates.push(path.resolve(planDir, token));
    else candidates.push(path.resolve(repoRoot, token), path.resolve(planDir, token));
  }
  for (const candidate of candidates) {
    if (documents.size > MAX_LINKED_DOCUMENTS) break;
    const document = await readInside(realRoot, candidate);
    if (document && !documents.has(document.path)) documents.set(document.path, document);
  }
  return [...documents.values()];
}

// ---- the record ------------------------------------------------------------------------------

async function recordPath(repoRoot: string, itemId: string): Promise<string> {
  return path.join(await harnessDir(repoRoot, 'queue-job-sent'), `${itemId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/** What was last sent for the item; empty when nothing was. */
export async function readSentRecord(repoRoot: string, itemId: string): Promise<SentRecord> {
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(await recordPath(repoRoot, itemId), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const record: SentRecord = {};
  for (const [file, entry] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
    const { sha256, contentBase64 } = (entry ?? {}) as Record<string, unknown>;
    if (QueueRelativePathSchema.safeParse(file).success && typeof sha256 === 'string' && typeof contentBase64 === 'string') {
      record[file] = { sha256, contentBase64 };
    }
  }
  return record;
}

export async function writeSentRecord(repoRoot: string, itemId: string, record: SentRecord): Promise<void> {
  const file = await recordPath(repoRoot, itemId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, file);
}

export async function clearSentRecord(repoRoot: string, itemId: string): Promise<void> {
  await fs.rm(await recordPath(repoRoot, itemId), { force: true });
}

/**
 * The record for the next send: the documents `collectOutgoingDocuments` picks now, plus every document sent
 * before that still exists, each with the main checkout's CURRENT bytes. A document that has gone is dropped.
 */
export async function refreshSentRecord(repoRoot: string, sourceRef: string, previous: SentRecord): Promise<SentRecord> {
  const realRoot = await fs.realpath(repoRoot);
  const documents = new Map((await collectOutgoingDocuments(repoRoot, sourceRef)).map(document => [document.path, document]));
  for (const file of Object.keys(previous)) {
    if (documents.has(file)) continue;
    const document = await readInside(realRoot, path.join(realRoot, ...file.split('/')));
    if (document) documents.set(file, document);
  }
  const record: SentRecord = {};
  for (const [file, document] of documents) record[file] = { sha256: document.sha256, contentBase64: document.bytes.toString('base64') };
  return record;
}

/** The documents `queue.prepare` carries, exactly as recorded. */
export function recordedDocuments(record: SentRecord): QueueDocument[] {
  return Object.entries(record).map(([file, entry]) => ({ path: file, contentBase64: entry.contentBase64 }));
}

// ---- coming back -----------------------------------------------------------------------------

export interface ApplyReturnedArgs {
  repoRoot: string;
  itemId: string;
  /** "the Windows PC": goes into the hold text. */
  computerLabel: string;
  /** What was sent (`readSentRecord`). */
  sent: SentRecord;
  /** The planning-folder files the job changed, as `queue.collect` returned them. */
  documents: readonly QueueDocument[];
  /** Sent documents that are gone over there. */
  deleted: readonly string[];
}

export interface ApplyReturnedResult {
  /** Sent documents the job changed, now replacing the main copy. */
  replaced: string[];
  /** Documents the job created (or was not sent with) that are new here. */
  created: string[];
  /** The job's version saved beside a different main copy (`<name>.from-queue-<item>.md`). */
  beside: { path: string; copy: string }[];
  /** The main copy already had the job's bytes: nothing was written. */
  identical: string[];
  /** Deleted over there; left in place here. */
  deletedFarSide: string[];
  /** Paths that are not safe repository paths, or bytes that could not be read: nothing was written for them. */
  rejected: { path: string; reason: string }[];
  /** Safe paths that could not be written. */
  failed: { path: string; reason: string }[];
  /** Set when a sent document changed here while the job was away; park the job with `hold.text`. */
  hold: { text: string; files: string[]; detail: string } | null;
  /** Every repository path this call wrote (replaced, created, and the beside copies). */
  written: string[];
  /** The record after this call: replaced documents carry the new bytes, created ones are added. Persist it with `writeSentRecord`. */
  sent: SentRecord;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function applyReturnedDocuments(args: ApplyReturnedArgs): Promise<ApplyReturnedResult> {
  const result: ApplyReturnedResult = {
    replaced: [], created: [], beside: [], identical: [], deletedFarSide: [], rejected: [], failed: [],
    hold: null, written: [], sent: { ...args.sent },
  };
  const realRoot = await fs.realpath(args.repoRoot);
  const holdFiles: { path: string; copy: string }[] = [];
  const unsent: { path: string; bytes: Buffer; existed: boolean }[] = [];
  const remember = (file: string, bytes: Buffer): void => {
    result.sent[file] = { sha256: digest(bytes), contentBase64: bytes.toString('base64') };
  };
  const isSafe = (file: string): boolean => QueueRelativePathSchema.safeParse(file).success && !file.split('/').includes('.git');

  for (const returned of args.documents) {
    if (!isSafe(returned.path)) { result.rejected.push({ path: returned.path, reason: 'not a path inside the project' }); continue; }
    const bytes = Buffer.from(returned.contentBase64, 'base64');
    if (bytes.length > MAX_PLANNING_DOCUMENT_BYTES) { result.rejected.push({ path: returned.path, reason: 'too large' }); continue; }
    const main = path.join(realRoot, ...returned.path.split('/'));
    const sentEntry = args.sent[returned.path];
    if (!sentEntry) { unsent.push({ path: returned.path, bytes, existed: await exists(main) }); continue; }
    try {
      await applySentDocument({ realRoot, main, bytes, sentSha: sentEntry.sha256, itemId: args.itemId, path: returned.path }, result, holdFiles, remember);
    } catch (error) {
      result.failed.push({ path: returned.path, reason: reasonOf(error) });
    }
  }
  if (unsent.length) await relocateUnsent(args, unsent, result, remember);

  for (const file of args.deleted) {
    if (isSafe(file)) result.deletedFarSide.push(file);
    else result.rejected.push({ path: file, reason: 'not a path inside the project' });
  }
  if (holdFiles.length) {
    const text = `${PLAN_CHANGED_HOLD_PREFIX}${args.computerLabel}`;
    result.hold = {
      text,
      files: holdFiles.map(file => file.path),
      detail: `${text}: ${holdFiles.map(file => `${file.path} (the job's version was saved as ${file.copy})`).join(', ')}.`,
    };
  }
  return result;
}

interface SentDocumentCase { realRoot: string; main: string; bytes: Buffer; sentSha: string; itemId: string; path: string }

/** A document the job was sent with. The main copy is replaced only if it is still what was sent. */
async function applySentDocument(
  one: SentDocumentCase, result: ApplyReturnedResult, holdFiles: { path: string; copy: string }[],
  remember: (file: string, bytes: Buffer) => void,
): Promise<void> {
  const keepBeside = async (mode: number): Promise<void> => {
    const copy = path.relative(one.realRoot, await saveBeside(one.realRoot, one.main, one.itemId, one.bytes, mode));
    result.beside.push({ path: one.path, copy });
    result.written.push(copy);
    holdFiles.push({ path: one.path, copy });
  };
  if (!(await exists(one.main))) { await keepBeside(0o644); return; }
  let identity: ReturnType<typeof documentFileIdentity>;
  let before: Buffer;
  try {
    identity = documentFileIdentity(one.main);
    before = await fs.readFile(one.main);
  } catch {
    // Not a regular file any more: that is a change here too.
    await keepBeside(0o644);
    return;
  }
  if (before.equals(one.bytes)) { result.identical.push(one.path); remember(one.path, one.bytes); return; }
  if (digest(before) !== one.sentSha) { await keepBeside(identity.stat.mode & 0o777); return; }
  try {
    assertDocumentFileUnchanged(identity, before);
    changeDocumentFile(identity, before, one.bytes);
  } catch {
    // It changed between the read and the write, or could not be claimed: the original is kept, so keep the job's beside it.
    await keepBeside(identity.stat.mode & 0o777);
    return;
  }
  result.replaced.push(one.path);
  result.written.push(one.path);
  remember(one.path, one.bytes);
}

/** Documents the job was not sent with: exactly the relocate rule, then the new ones count as sent. */
async function relocateUnsent(
  args: ApplyReturnedArgs, unsent: { path: string; bytes: Buffer; existed: boolean }[],
  result: ApplyReturnedResult, remember: (file: string, bytes: Buffer) => void,
): Promise<void> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-queue-docs-'));
  try {
    for (const document of unsent) {
      const target = path.join(scratch, ...document.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, document.bytes, { mode: 0o644 });
    }
    const report = await relocatePlanningFiles({ itemId: args.itemId, worktreePath: scratch, repoRoot: args.repoRoot }, unsent.map(document => document.path));
    const byPath = new Map(unsent.map(document => [document.path, document]));
    for (const file of report.moved) {
      const document = byPath.get(file);
      if (!document) continue;
      if (document.existed) { result.identical.push(file); continue; }
      result.created.push(file);
      result.written.push(file);
      remember(file, document.bytes);
    }
    for (const entry of report.beside) { result.beside.push(entry); result.written.push(entry.copy); }
    for (const entry of report.failed) result.failed.push({ path: entry.path, reason: entry.reason });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

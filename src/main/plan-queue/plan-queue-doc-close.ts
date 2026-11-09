/**
 * Plan Queue document lifecycle — the coordinator, never the worker, moves a
 * document to its `_completed` name, and only after a verifier PASS.
 *
 * Documents live untracked in the ROOT checkout (that visibility is the
 * operator's review queue). For documents inside the repository the closed
 * copies are prepared here, before anything lands, and go into the item's
 * landing commit itself (made with the repository's hooks), so code and
 * documents land together or not at all; afterwards the superseded root
 * copies are retired. Documents kept outside the repository (the EBRD layout)
 * or ignored by it are never committed; they are renamed in place instead.
 * Every step tolerates being re-run after a crash.
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import * as fs from 'fs/promises';
import * as path from 'path';
import { assertDocumentFileUnchanged, changeDocumentFile, documentFileIdentity } from './plan-queue-document-mutation';
import { gitExec } from '../workspace/git/git-exec';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { closeSmallDocument, completedHistoryPath, documentHistoryPath } from './plan-queue-plan-diet';
import type { LandingDocument } from './plan-queue-squash';
import { branchExists, commitsAhead } from './plan-queue-git';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { closedIntegrationContent, otherUnlandedBranches } from './plan-queue-document-status';

import { assertDocumentReview, linkedSpecPaths, readDocumentReview, type DocumentReview } from './plan-queue-document-review';

const COMPLETED_SUFFIX = '_completed.md';

export type PreparedDocuments =
  /** Inside the repository: these closed copies go into the landing commit. */
  | { mode: 'commit'; documents: LandingDocument[] }
  /** Outside the repository or ignored by it: rename in place after landing. */
  | { mode: 'rename-in-place' };

export function completedDocumentPath(documentPath: string): string {
  if (documentPath.endsWith(COMPLETED_SUFFIX)) return documentPath;
  // A planned spec closes to `_spec_completed.md`, not `_spec_planned_completed.md`.
  if (/_spec_planned\.md$/i.test(documentPath)) return documentPath.replace(/_spec_planned\.md$/i, '_spec_completed.md');
  return documentPath.replace(/\.md$/i, COMPLETED_SUFFIX);
}

async function exists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * The plan's active spec, beside the plan or in a sibling `specs/` directory
 * (the docs/superpowers layout). Recovery uses the receipt's recorded paths.
 */
async function findSpec(planPath: string): Promise<string | null> {
  for (const candidate of linkedSpecPaths(planPath)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/** Re-point a plan↔spec link from the active name to the completed one. Idempotent. */
function repointLink(content: string, activeName: string, completedName: string): string {
  // Safe to re-run: no completed name contains its active name.
  return content.split(activeName).join(completedName);
}

/** The cross-link each document carries: the plan names its spec, the spec names its plan. */
function linkFor(documentPath: string, isSpec: boolean, planPath: string): { from: string; to: string } {
  const planName = path.basename(planPath);
  if (isSpec) return { from: planName, to: path.basename(completedDocumentPath(planPath)) };
  const specPlanned = planName.replace(/_plan\.md$/i, '_spec_planned.md');
  return { from: specPlanned, to: specPlanned.replace(/_spec_planned\.md$/i, '_spec_completed.md') };
}

/** Whether a path inside the repository is committed there (not outside it, not ignored). */
async function committable(file: string, repoRoot: string): Promise<boolean> {
  const relative = path.relative(repoRoot, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  try { await gitExec(['check-ignore', '-q', '--', relative], repoRoot); return false; }
  catch (error) {
    if ((error as { code?: unknown }).code === 1) return true;
    throw error;
  }
}

/** Whether this document's closed copy is committed (inside the repository, not ignored). */
export async function documentsAreCommitted(documentPath: string, repoRoot: string): Promise<boolean> {
  return committable(documentPath, repoRoot);
}

function toRepoPath(file: string, repoRoot: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/**
 * Closure evidence survives a coordinator restart and Git's landing boundary.
 * Source hashes are of the ORIGINAL bytes, before links or slimming change them.
 * The shared active history is a snapshot dependency, never a retirement target.
 */
const digest = (content: string): string => createHash('sha256').update(content).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const closureSchema = z.object({
  version: z.literal(1),
  sources: z.array(z.object({ relativePath: z.string(), sha256: hashSchema.nullable(), retire: z.boolean() })),
  outputs: z.array(z.object({ relativePath: z.string(), sha256: hashSchema })),
  // Optional for receipts written before candidate history was snapshotted.
  candidateHistorySha256: hashSchema.nullable().optional(),
});
type Closure = z.infer<typeof closureSchema>;
interface Snapshot { file: string; content: string | null; retire: boolean }
interface ClosureBundle { closure: Closure; documents: LandingDocument[]; snapshots: Snapshot[] }
interface CandidateHistory { relativePath: string; content: string | null }

function closureIdentity(sources: Closure['sources'], candidateHistorySha256?: string | null): string {
  return digest(JSON.stringify(candidateHistorySha256 === undefined ? sources : { sources, candidateHistorySha256 }));
}

function closurePath(documentPath: string): string {
  return documentPath.replace(/\.md$/i, '_closure_completed.json');
}

async function readOptional(file: string): Promise<string | null> {
  try {
    const identity = documentFileIdentity(file);
    const bytes = await fs.readFile(file);
    assertDocumentFileUnchanged(identity, bytes);
    return documentText(bytes, file);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function documentText(bytes: Buffer, file: string): string {
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`Document closure requires valid UTF-8: ${path.basename(file)}`);
  return content;
}

function receiptContent(closure: Closure): string { return `${JSON.stringify(closure, null, 2)}\n`; }

/** Reject receipts that could redirect cleanup outside this document's family. */
function parseClosure(content: string, documentPath: string): Closure {
  const closure = closureSchema.parse(JSON.parse(content));
  const dir = path.dirname(documentPath);
  const specName = path.basename(documentPath).replace(/_plan\.md$/i, '_spec_planned.md');
  const specs = /_plan\.md$/i.test(documentPath)
    ? [path.join(dir, specName), path.normalize(path.join(dir, '..', 'specs', specName))] : [];
  const activeNames = [documentPath, ...specs].map(file => path.resolve(file));
  const historyNames = [documentHistoryPath(documentPath), completedHistoryPath(documentPath)].map(file => path.resolve(file));
  const resolve = (relative: string): string => path.resolve(dir, relative);
  const retired = closure.sources.filter(source => source.retire);
  const closedNames = retired.map(source => completedDocumentPath(resolve(source.relativePath)));
  const ownedHistory = documentPath.replace(/\.md$/i, `_history_${closureIdentity(closure.sources, closure.candidateHistorySha256)}_completed.md`);
  if (!closure.sources.some(source => resolve(source.relativePath) === path.resolve(documentPath) && source.retire)
    || closure.sources.some(source => source.retire
      ? source.sha256 === null || !activeNames.includes(resolve(source.relativePath))
      : !historyNames.includes(resolve(source.relativePath)))
    || retired.length > 2
    || closure.sources.filter(source => !source.retire).length !== historyNames.length
    || closedNames.some(file => !closure.outputs.some(output => resolve(output.relativePath) === file))
    || closure.outputs.some(output => ![...closedNames, ownedHistory].includes(resolve(output.relativePath)))
    || new Set(closure.sources.map(source => resolve(source.relativePath))).size !== closure.sources.length
    || new Set(closure.outputs.map(output => resolve(output.relativePath))).size !== closure.outputs.length) {
    throw new Error('Invalid document closure ownership');
  }
  return closure;
}

/**
 * Each closure owns a history named for the full document basename AND its
 * input digest. Related plan/livetest closures cannot replace one another's
 * histories. Legacy completed histories remain immutable; their bytes and the
 * shared active history are included in the new snapshot alongside the journal.
 */
async function buildClosure(documentPath: string, candidate: CandidateHistory | null, reviewedSha256: DocumentReview | null,
  landedCommit?: string): Promise<ClosureBundle> {
  if (documentPath === completedDocumentPath(documentPath)) throw new Error('Cannot close an already completed document');
  const spec = await findSpec(documentPath);
  const actives = spec ? [documentPath, spec] : [documentPath];
  const snapshots: Snapshot[] = [];
  for (const file of actives) {
    const content = await readOptional(file);
    if (content === null) throw new Error(`Document not found: ${file}`);
    snapshots.push({ file, content, retire: true });
  }
  if (reviewedSha256) assertDocumentReview(await readDocumentReview(documentPath), reviewedSha256);
  assertReviewedHash(digest(snapshots[0].content!), reviewedSha256);
  for (const file of [documentHistoryPath(documentPath), completedHistoryPath(documentPath)]) {
    snapshots.push({ file, content: await readOptional(file), retire: false });
  }
  const dir = path.dirname(documentPath);
  const sources = snapshots.map(source => ({ relativePath: toRepoPath(source.file, dir),
    sha256: source.content === null ? null : digest(source.content), retire: source.retire }));
  const candidateHistorySha256 = candidate ? (candidate.content === null ? null : digest(candidate.content)) : undefined;
  const identity = closureIdentity(sources, candidateHistorySha256);
  const history = documentPath.replace(/\.md$/i, `_history_${identity}_completed.md`);
  const historyName = path.basename(history);
  const planLink = linkFor(documentPath, false, documentPath);
  const linked = repointLink(snapshots[0].content!, planLink.from, planLink.to);
  const slimmed = closeSmallDocument(linked, historyName);
  // Keep prior records verbatim, including empty records and trailing whitespace.
  const records = snapshots.filter(source => !source.retire && source.content !== null)
    .map(source => `## Snapshot of ${path.basename(source.file)}\n\n${source.content}`);
  if (candidate && candidate.content !== null) {
    records.push(`## Candidate snapshot of ${path.basename(candidate.relativePath)}\n\n${candidate.content}`);
  }
  if (slimmed.moved) records.push(slimmed.moved);
  const documents: LandingDocument[] = [];
  let closedContent = slimmed.content;
  if (records.length) {
    closedContent = repointLink(closedContent, path.basename(documentHistoryPath(documentPath)), historyName);
    if (!closedContent.includes(historyName)) closedContent += `\n> Closure history: \`${historyName}\`.\n`;
  }
  documents.push({ relativePath: toRepoPath(completedDocumentPath(documentPath), dir), content: closedIntegrationContent(closedContent, landedCommit) });
  if (records.length) documents.push({ relativePath: toRepoPath(history, dir), content: records.join('\n\n'),
    ...(candidate ? { historySource: { relativePath: candidate.relativePath,
      sha256: candidate.content === null ? null : digest(candidate.content) } } : {}) });
  if (spec) {
    const link = linkFor(spec, true, documentPath);
    documents.push({ relativePath: toRepoPath(completedDocumentPath(spec), dir),
      content: closedIntegrationContent(repointLink(snapshots[1].content!, link.from, link.to), landedCommit) });
  }
  const closure: Closure = { version: 1, sources, ...(candidate ? { candidateHistorySha256 } : {}),
    outputs: documents.map(doc => ({ relativePath: doc.relativePath, sha256: digest(doc.content) })) };
  assertReviewedClosure(closure, documentPath, reviewedSha256);
  return { closure, documents, snapshots };
}

function assertReviewedHash(actual: string | null | undefined, reviewedSha256: DocumentReview | null): void {
  if (reviewedSha256 !== null && actual !== reviewedSha256.documentSha256) {
    throw new Error('The source document changed after its checker passed; keep it open and check it again.');
  }
}

function assertReviewedClosure(closure: Closure, documentPath: string, reviewedSha256: DocumentReview | null): void {
  const source = closure.sources.find(source => path.resolve(path.dirname(documentPath), source.relativePath) === path.resolve(documentPath));
  assertReviewedHash(source?.sha256, reviewedSha256);
  if (reviewedSha256) {
    const specs = linkedSpecPaths(documentPath);
    const actual = specs.map(file => closure.sources.find(source => source.retire && path.resolve(path.dirname(documentPath), source.relativePath) === file)?.sha256 ?? null);
    // Closure retires the first existing spec only; reject an ambiguous second spec.
    if (JSON.stringify(actual) !== JSON.stringify(reviewedSha256.linkedSpecSha256)) throw new Error('The linked specification has no matching checker identity; check it again.');
  }
}

async function assertActiveReview(documentPath: string, reviewed: DocumentReview | null): Promise<void> {
  if (!reviewed) return;
  for (const [index, file] of [documentPath, ...linkedSpecPaths(documentPath)].entries()) {
    const current = await readOptional(file);
    const expected = index === 0 ? reviewed.documentSha256 : reviewed.linkedSpecSha256[index - 1];
    // Already retired sources may be absent, but newly introduced or changed
    // active documents can never be converted into a successful cleanup note.
    if (current !== null && digest(current) !== expected) throw new Error('The source document or linked specification changed; keep it open and check it again.');
  }
}

async function assertSources(closure: Closure, documentPath: string, allowRetired = false): Promise<void> {
  for (const spec of linkedSpecPaths(documentPath)) {
    if (!closure.sources.some(source => path.resolve(path.dirname(documentPath), source.relativePath) === spec) && await exists(spec)) {
      throw new Error('A linked specification appeared while closing; keep it open and check it again.');
    }
  }
  for (const source of closure.sources) {
    const file = path.resolve(path.dirname(documentPath), source.relativePath);
    const current = await readOptional(file);
    if (allowRetired && source.retire && current === null) continue;
    if ((current === null ? null : digest(current)) !== source.sha256) {
      throw new Error(`Document or history changed while closing: ${path.basename(file)}`);
    }
  }
}

async function assertFree(bundle: ClosureBundle, documentPath: string): Promise<void> {
  for (const target of [closurePath(documentPath), ...bundle.documents.map(doc => path.resolve(path.dirname(documentPath), doc.relativePath))]) {
    if (await exists(target)) throw new Error(`Refusing to overwrite ${target}`);
  }
}

/**
 * A plan whose Status says some of its work is on another branch must stay open: closing it would
 * hide that work. Checked before anything lands, on the plan and its linked spec.
 */
export async function assertNoOtherUnlandedWork(documentPath: string, landingBranch: string): Promise<void> {
  for (const file of [documentPath, await findSpec(documentPath)]) {
    const others = file ? otherUnlandedBranches(await fs.readFile(file, 'utf8'), landingBranch) : [];
    if (file && others.length) {
      throw new Error(`Refusing to close ${path.basename(file)}: its Status names other unlanded work (${others.join(', ')}). Edit the "On main" line if that is wrong`);
    }
  }
}

/** Prepare immutable closed copies and their source/output identity without root writes. */
export async function prepareClosedDocuments(documentPath: string, repoRoot: string, worktreePath: string | null, reviewedSha256: DocumentReview | null): Promise<PreparedDocuments> {
  const relativeHistory = toRepoPath(documentHistoryPath(documentPath), repoRoot);
  const candidate = worktreePath && !relativeHistory.startsWith('../') && !path.isAbsolute(relativeHistory)
    ? { relativePath: relativeHistory, content: await committedContent(path.join(worktreePath, relativeHistory), worktreePath, 'HEAD') } : null;
  const bundle = await buildClosure(documentPath, candidate, reviewedSha256);
  await assertFree(bundle, documentPath);
  const inRepo = await Promise.all(bundle.snapshots.filter(source => source.retire).map(source => committable(source.file, repoRoot)));
  if (!inRepo.every(Boolean) && !inRepo.every(value => !value)) {
    throw new Error('The plan and its spec are split across the repository boundary; close them by hand');
  }
  await assertSources(bundle.closure, documentPath);
  if (inRepo.every(value => !value)) return { mode: 'rename-in-place' };
  const dir = path.dirname(documentPath);
  const documents = bundle.documents.map(doc => ({ ...doc, relativePath: toRepoPath(path.resolve(dir, doc.relativePath), repoRoot) }));
  documents.push({ relativePath: toRepoPath(closurePath(documentPath), repoRoot), content: receiptContent(bundle.closure) });
  // A local deletion is not permission to replace an immutable tracked file.
  for (const doc of documents) {
    if (await gitExec(['ls-files', '--', doc.relativePath], repoRoot)
      || await gitExec(['ls-tree', 'HEAD', '--', doc.relativePath], repoRoot)) {
      throw new Error(`Refusing to overwrite ${doc.relativePath}`);
    }
  }
  await assertSources(bundle.closure, documentPath);
  if (candidate && await committedContent(path.join(worktreePath!, candidate.relativePath), worktreePath!, 'HEAD') !== candidate.content) {
    throw new Error('Candidate history changed while closing');
  }
  return { mode: 'commit', documents };
}

async function assertLocalOutputs(outputs: Closure['outputs'], documentPath: string): Promise<void> {
  for (const output of outputs) {
    const current = await readOptional(path.resolve(path.dirname(documentPath), output.relativePath));
    if (current === null || digest(current) !== output.sha256) throw new Error(`Closed evidence changed or missing: ${output.relativePath}`);
  }
}

/** Re-read immediately before each removal; never remove the shared active history. */
async function removeSources(closure: Closure, documentPath: string): Promise<void> {
  for (const source of closure.sources.filter(source => source.retire)) {
    const file = path.resolve(path.dirname(documentPath), source.relativePath);
    if (!(await exists(file))) continue;
    const identity = documentFileIdentity(file);
    await assertSources(closure, documentPath, true);
    const content = await fs.readFile(file);
    if (digest(documentText(content, file)) !== source.sha256) throw new Error('The source document changed before retirement; check it again.');
    changeDocumentFile(identity, content, null);
  }
}

async function hasActiveSources(closure: Closure, documentPath: string): Promise<boolean> {
  for (const source of closure.sources.filter(source => source.retire)) {
    if (await exists(path.resolve(path.dirname(documentPath), source.relativePath))) return true;
  }
  return false;
}

/** Publish complete bytes atomically, with no replacement even after a racing create. */
async function publishExclusive(file: string, content: string, checkSources: () => Promise<void>): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf-8', flag: 'wx' });
    await checkSources();
    await fs.link(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Publish final bytes once, with exclusive creation. A durable receipt precedes
 * the copies, so interrupted publication can resume without rewriting a closed
 * document. The original inputs remain until ALL output hashes are verified.
 * Legacy closed files without a receipt are never treated as mutable scratch.
 */
export async function renameDocumentsInPlace(documentPath: string, reviewedSha256: DocumentReview | null, landedCommit?: string): Promise<string[]> {
  const dir = path.dirname(documentPath);
  const receiptPath = closurePath(documentPath);
  const receipt = await readOptional(receiptPath);
  let closure: Closure;
  let bundle: ClosureBundle | undefined;
  if (receipt === null) {
    bundle = await buildClosure(documentPath, null, reviewedSha256, landedCommit);
    await assertFree(bundle, documentPath);
    await assertSources(bundle.closure, documentPath);
    closure = bundle.closure;
    await publishExclusive(receiptPath, receiptContent(closure), () => assertSources(closure, documentPath));
  } else {
    closure = parseClosure(receipt, documentPath);
    assertReviewedClosure(closure, documentPath, reviewedSha256);
    if (await hasActiveSources(closure, documentPath)) await assertSources(closure, documentPath, true);
    // If inputs still exist, reconstruct a partially published closure exactly.
    if (await exists(documentPath)) {
      bundle = await buildClosure(documentPath, null, reviewedSha256, landedCommit);
      if (receiptContent(bundle.closure) !== receiptContent(closure)) throw new Error('Closure inputs changed; refusing to overwrite completed documents');
    }
  }
  if (bundle) {
    // The completed plan is the completion trigger: publish it after its evidence.
    const planName = path.basename(completedDocumentPath(documentPath));
    const publications = [...bundle.documents].sort((a, b) => Number(a.relativePath === planName) - Number(b.relativePath === planName));
    const published: Closure['outputs'] = [];
    for (const doc of publications) {
      await assertSources(closure, documentPath);
      const target = path.resolve(dir, doc.relativePath);
      try {
        await publishExclusive(target, doc.content, async () => {
          await assertSources(closure, documentPath);
          await assertLocalOutputs(published, documentPath);
        });
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await readOptional(target) !== doc.content) throw new Error(`Refusing to overwrite ${target}`);
      }
      published.push({ relativePath: doc.relativePath, sha256: digest(doc.content) });
    }
  }
  await assertLocalOutputs(closure.outputs, documentPath);
  await removeSources(closure, documentPath);
  return closure.outputs.filter(output => !/_history_[a-f0-9]{64}_completed\.md$/.test(output.relativePath))
    .map(output => path.resolve(dir, output.relativePath));
}

const execFileAsync = promisify(execFile);
/** gitExec trims stdout; closure identity must include every committed byte. */
async function committedContent(file: string, repoRoot: string, revision: string): Promise<string | null> {
  const relative = toRepoPath(file, repoRoot);
  // A missing path is expected on old landings; command/permission failures are not.
  const present = await gitExec(['ls-tree', revision, '--', relative], repoRoot);
  if (!present) return null;
  if (!/^100(?:644|755) blob /.test(present)) throw new Error(`Document closure requires a regular file: ${path.basename(file)}`);
  const { stdout } = await execFileAsync('git', ['show', `${revision}:${relative}`], {
    cwd: repoRoot, env: hermeticGitEnv(), encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, timeout: 30_000,
  });
  return documentText(stdout, file);
}

/** Retire only original inputs whose entire closure evidence is intact on base and disk. */
export async function retireActiveDocuments(documentPath: string, repoRoot: string, baseBranch: string, reviewedSha256: DocumentReview | null): Promise<string[]> {
  const revision = await gitExec(['rev-parse', baseBranch], repoRoot);
  const receipt = await committedContent(closurePath(documentPath), repoRoot, revision);
  if (receipt === null) {
    if (await committedContent(completedDocumentPath(documentPath), repoRoot, revision) === null) return [];
    // Old landing commits have no original-input proof. Preserve their root copies.
    return await exists(documentPath) ? [`Kept ${path.basename(documentPath)}: its landing has no closure identity.`] : [];
  }
  const closure = parseClosure(receipt, documentPath);
  assertReviewedClosure(closure, documentPath, reviewedSha256);
  // A source edit after promotion still requires review; do not turn it into a landed row.
  await assertActiveReview(documentPath, reviewedSha256);
  try {
    if (!(await hasActiveSources(closure, documentPath))) return [];
    const localReceipt = await readOptional(closurePath(documentPath));
    if (localReceipt !== receipt) throw new Error('Closure identity changed or missing in the root checkout');
    await assertSources(closure, documentPath, true);
    for (const output of closure.outputs) {
      const content = await committedContent(path.resolve(path.dirname(documentPath), output.relativePath), repoRoot, revision);
      if (content === null || digest(content) !== output.sha256) throw new Error(`Landed evidence changed or missing: ${output.relativePath}`);
    }
    await assertLocalOutputs(closure.outputs, documentPath);
    await removeSources(closure, documentPath);
    return [];
  } catch (error) {
    await assertActiveReview(documentPath, reviewedSha256);
    return [`Kept ${path.basename(documentPath)}: ${error instanceof Error ? error.message : String(error)}; its closure could not be verified.`];
  }
}

/** Keep a parked branch findable, extending review acceptance only for the exact note write. */
export async function appendParkedBranchNote(item: PlanQueueItem, run: PlanQueueRun, reason: PlanQueueParkReason,
  history: PlanQueueHistoryStore): Promise<string | null> {
  if (!item.branchName || !run.config.baseBranch || !(await branchExists(run.workspaceCwd, item.branchName))) return null;
  const commitCount = await commitsAhead(run.workspaceCwd, run.config.baseBranch, item.branchName);
  if (commitCount <= 0) return null;
  try {
    const change = await appendParkedNote(item.sourceRef, { branchName: item.branchName, reason, commitCount });
    history.recordDocumentTransformation(item, change);
    return null;
  } catch (error) {
    return `The parked-work note was not written: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** One findable line in the document naming the parked branch. Never duplicates. */
export async function appendParkedNote(
  documentPath: string,
  note: { branchName: string; reason: string; commitCount: number },
): Promise<{ beforeSha256: string; afterSha256: string } | undefined> {
  if (!(await exists(documentPath))) return;
  const marker = `Plan Queue parked work: \`${note.branchName}\``;
  const identity = documentFileIdentity(documentPath);
  const bytes = await fs.readFile(documentPath);
  const content = documentText(bytes, documentPath);
  if (content.includes(marker)) return;
  // The document stays byte for byte above the note: its closed copy is checked against the hash of those bytes.
  const updated = `${content}\n\n> ${marker} — ${note.commitCount} commit(s), reason: ${note.reason}.\n`;
  changeDocumentFile(identity, bytes, updated);
  return { beforeSha256: digest(content), afterSha256: digest(updated) };
}

/** Remove only this item's parked-branch line before rebuilding a verified landing. */
export async function removeParkedNote(documentPath: string, branchName: string): Promise<{ beforeSha256: string; afterSha256: string } | undefined> {
  if (!(await exists(documentPath))) return;
  const marker = `> Plan Queue parked work: \`${branchName}\``;
  const identity = documentFileIdentity(documentPath);
  const bytes = await fs.readFile(documentPath);
  const content = documentText(bytes, documentPath);
  const last = content.lastIndexOf(`\n\n${marker}`);
  const updated = last >= 0 && content.indexOf('\n', last + 2) === content.length - 1
    ? content.slice(0, last)
    // Text added below the note, or a note written before this was exact.
    : content.split('\n').filter((line) => !line.startsWith(marker)).join('\n');
  if (updated === content) return;
  changeDocumentFile(identity, bytes, updated);
  return { beforeSha256: digest(content), afterSha256: digest(updated) };
}

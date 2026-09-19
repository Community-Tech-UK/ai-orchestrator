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

import * as fs from 'fs/promises';
import * as path from 'path';
import { gitExec } from '../workspace/git/git-exec';
import type { LandingDocument } from './plan-queue-squash';

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
  return fs.stat(target).then(() => true, () => false);
}

/**
 * The plan's spec, under the given suffix (`_spec_planned.md` before closing,
 * `_spec_completed.md` after), beside the plan or in a sibling `specs/`
 * directory (the docs/superpowers layout). Both the first pass and a re-run
 * after a crash search the same places.
 */
async function findSpec(planPath: string, suffix: '_spec_planned.md' | '_spec_completed.md'): Promise<string | null> {
  const base = path.basename(planPath);
  if (!/_plan\.md$/i.test(base)) return null;
  const specName = base.replace(/_plan\.md$/i, suffix);
  const planDir = path.dirname(planPath);
  for (const candidate of [
    path.join(planDir, specName),
    path.join(planDir, '..', 'specs', specName),
  ]) {
    if (await exists(candidate)) return path.normalize(candidate);
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
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return gitExec(['check-ignore', '-q', '--', relative], repoRoot).then(() => false, () => true);
}

/** Whether this document's closed copy is committed (inside the repository, not ignored). */
export async function documentsAreCommitted(documentPath: string, repoRoot: string): Promise<boolean> {
  return committable(documentPath, repoRoot);
}

function toRepoPath(file: string, repoRoot: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/**
 * Prepare the closed documents WITHOUT touching the root checkout. Throws when
 * they cannot be closed (missing, a completed name already taken, or a plan and
 * spec split across the repository boundary) — before anything has landed.
 */
export async function prepareClosedDocuments(documentPath: string, repoRoot: string): Promise<PreparedDocuments> {
  if (!(await exists(documentPath))) throw new Error(`Document not found: ${documentPath}`);
  const spec = await findSpec(documentPath, '_spec_planned.md');
  const actives = spec ? [documentPath, spec] : [documentPath];

  const inRepo = await Promise.all(actives.map((file) => committable(file, repoRoot)));
  if (inRepo.every((value) => !value)) {
    for (const active of actives) {
      if (await exists(completedDocumentPath(active))) throw new Error(`Refusing to overwrite ${completedDocumentPath(active)}`);
    }
    return { mode: 'rename-in-place' };
  }
  if (!inRepo.every(Boolean)) {
    throw new Error('The plan and its spec are split across the repository boundary; close them by hand');
  }

  const documents: LandingDocument[] = [];
  for (const active of actives) {
    const closed = completedDocumentPath(active);
    if (await exists(closed)) throw new Error(`Refusing to overwrite ${closed}`);
    const link = linkFor(active, active === spec, documentPath);
    const content = repointLink(await fs.readFile(active, 'utf-8'), link.from, link.to);
    documents.push({ relativePath: toRepoPath(closed, repoRoot), content });
  }
  return { mode: 'commit', documents };
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  if (from === to) return;
  if (await exists(from)) {
    if (await exists(to)) throw new Error(`Refusing to overwrite ${to}`);
    await fs.rename(from, to);
  } else if (!(await exists(to))) {
    throw new Error(`Document not found: ${from}`);
  }
}

async function repointFile(file: string, from: string, to: string): Promise<void> {
  const content = await fs.readFile(file, 'utf-8');
  const updated = repointLink(content, from, to);
  if (updated !== content) await fs.writeFile(file, updated, 'utf-8');
}

/**
 * Close documents that are never committed (outside the repository or ignored
 * by it): rename both to `_completed` and re-point their links. Idempotent,
 * including after a crash between any two steps.
 */
export async function renameDocumentsInPlace(documentPath: string): Promise<string[]> {
  const closedDocument = completedDocumentPath(documentPath);
  await renameIfPresent(documentPath, closedDocument);
  const plannedSpec = await findSpec(documentPath, '_spec_planned.md');
  let closedSpec: string | null = null;
  if (plannedSpec) {
    closedSpec = completedDocumentPath(plannedSpec);
    await renameIfPresent(plannedSpec, closedSpec);
  } else {
    closedSpec = await findSpec(documentPath, '_spec_completed.md');
  }
  if (!closedSpec) return [closedDocument];
  // Always repair the links, including on a re-run: a crash can land between
  // the renames and this step.
  const planLink = linkFor(documentPath, false, documentPath);
  const specLink = linkFor(closedSpec, true, documentPath);
  await repointFile(closedDocument, planLink.from, planLink.to);
  await repointFile(closedSpec, specLink.from, specLink.to);
  return [closedDocument, closedSpec];
}

/**
 * After the landing commit reached `baseBranch`, remove the root checkout's
 * active copies it superseded — but only a copy still identical to what was
 * committed (links re-pointed). A copy edited since is kept and reported.
 * Idempotent: a copy already removed is simply skipped.
 */
export async function retireActiveDocuments(documentPath: string, repoRoot: string, baseBranch: string): Promise<string[]> {
  const spec = await findSpec(documentPath, '_spec_planned.md');
  const notes: string[] = [];
  for (const active of spec ? [documentPath, spec] : [documentPath]) {
    if (!(await exists(active))) continue;
    const committed = await gitExec(['show', `${baseBranch}:${toRepoPath(completedDocumentPath(active), repoRoot)}`], repoRoot)
      .catch(() => null);
    if (committed === null) continue;
    const link = linkFor(active, active === spec, documentPath);
    const expected = repointLink(await fs.readFile(active, 'utf-8'), link.from, link.to);
    if (expected.trim() === committed.trim()) {
      await fs.unlink(active);
    } else {
      notes.push(`Kept ${path.basename(active)}: it changed after the landing commit was built; its completed copy is on ${baseBranch}.`);
    }
  }
  return notes;
}

/** One findable line in the document naming the parked branch. Never duplicates. */
export async function appendParkedNote(
  documentPath: string,
  note: { branchName: string; reason: string; commitCount: number },
): Promise<void> {
  if (!(await exists(documentPath))) return;
  const marker = `Plan Queue parked work: \`${note.branchName}\``;
  const content = await fs.readFile(documentPath, 'utf-8');
  if (content.includes(marker)) return;
  const line = `\n\n> ${marker} — ${note.commitCount} commit(s), reason: ${note.reason}.\n`;
  await fs.writeFile(documentPath, content.replace(/\s*$/, '') + line, 'utf-8');
}

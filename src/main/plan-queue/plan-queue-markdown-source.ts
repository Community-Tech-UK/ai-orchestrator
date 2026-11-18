/**
 * The markdown work source: a run's items are plan (`_plan.md`, an unplanned `_spec.md`) or livetest
 * (`_livetest.md`) files in the repository's ROOT checkout.
 *
 * This adapter only forwards to the code that has always done each job (discovery, readiness, closing documents,
 * merging with the root checkout's edits, parked notes, naming), so nothing here changes behaviour. The one thing it
 * owns is the naming rules, which used to be repeated in six places.
 */

import { readFileSync, statSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { gitExec } from '../workspace/git/git-exec';
import { discoverPlanQueueDocuments } from './plan-queue-discovery';
import { appendParkedBranchNote, assertNoOtherUnlandedWork, documentsAreCommitted, prepareClosedDocuments, removeParkedNote, renameDocumentsInPlace, retireActiveDocuments } from './plan-queue-doc-close';
import { createDocumentOverlapResolver, recoverDocumentMergeForItem, recoverInterruptedDocumentMerges, resolveRegisterClash, rootEditWouldMerge } from './plan-queue-doc-merge';
import { repeatedStopNote } from './plan-queue-document-memory';
import { assertDocumentReview, readDocumentReview } from './plan-queue-document-review';
import { isLargeQueueDocument } from './plan-queue-document-policy';
import { updatePlanIntegrationStatus } from './plan-queue-document-status';
import { dietAtCheckpoint } from './plan-queue-plan-diet';
import { bounded, PLAN_BRIEF_BYTES, readPlanBrief } from './plan-queue-plan-extract';
import { comparePinnedUnchecked, extractChecklistItems, readPlanPin } from './plan-queue-plan-pins';
import { documentContentSha256 } from './plan-queue-progress';
import { buildFixPrompt, buildResumePrompt, buildStepUpInstruction, buildStepUpPrompt, buildVerifierPrompt, buildWorkerPrompt } from './plan-queue-prompts';
import { missingDocumentNote, reconcileWaitingDocuments } from './plan-queue-readiness';
import { finishesPlan, stepPlanProblem, stepsToRun } from './plan-queue-sections';
import { completedDocumentPath } from './plan-queue-doc-close';
import { rememberedOutcomeForPath } from './plan-queue-triage-memory';
import type { QueueWorkSource, QueueWorkerPrompts, WorkCandidate, WorkerPromptBase } from './plan-queue-work-source';

/** One worker rarely finishes more than this in a job (step 5.1); revisit with Queue health's numbers. */
const OVERSIZED_BYTES = 50_000;
const OVERSIZED_OPEN_ITEMS = 20;

/** Why a bulk start leaves a plan out as too big for one job, or null. Picking it by name still starts it. */
export function oversizedNote(documentPath: string): string | null {
  let size: number;
  try { size = statSync(documentPath).size; } catch { return null; }
  const kilobytes = Math.round(size / 1000);
  // Too big already: no need to read it, and this runs on the main thread.
  if (size > OVERSIZED_BYTES) return `Left out of this run: at ${kilobytes} KB it is likely too big for one job. Split it, or pick it by name to start it anyway.`;
  let open: number;
  try { open = readFileSync(documentPath, 'utf8').match(/^\s*[-*] \[ \]/gm)?.length ?? 0; } catch { return null; }
  if (open <= OVERSIZED_OPEN_ITEMS) return null;
  return `Left out of this run: with ${open} unticked items it is likely too big for one job. Split it, or pick it by name to start it anyway.`;
}

/** The file name without its extension, from a path written on either platform. */
function stem(ref: string): string {
  return (ref.split(/[\\/]/).pop() ?? ref).replace(/\.md$/i, '');
}

/** The plan's Status and open work, read fresh from the root checkout; a livetest has none. */
async function withPlanBrief(base: WorkerPromptBase) {
  const { lastStepOfRun, ...context } = base;
  if (base.kind !== 'plans') return context;
  const brief = await readPlanBrief(base.item.sourceRef, base.item.section);
  // The step that writes the as-built summary is the run's last job, which is not the plan's last heading when that step is already ticked off.
  return { ...context, brief: brief.step ? { ...brief, step: { ...brief.step, last: lastStepOfRun } } : brief };
}

const markdownWorkerPrompts: QueueWorkerPrompts = {
  first: async base => buildWorkerPrompt(await withPlanBrief(base)),
  resume: async (base, reason) => buildResumePrompt(await withPlanBrief(base), reason),
  stepUp: async (base, failedRounds, findings) => buildStepUpPrompt(await withPlanBrief(base), failedRounds, findings),
  fix: async (_run, _item, round, maxRounds, findings, planningNote, directChanges) => buildFixPrompt(round, maxRounds, findings, planningNote, directChanges),
};

async function documentState(documentPath: string): Promise<'open' | 'closed' | 'gone'> {
  const exists = (file: string) => fs.access(file).then(() => true, () => false);
  if (await exists(completedDocumentPath(documentPath))) return 'closed';
  return await exists(documentPath) ? 'open' : 'gone';
}

export const markdownWorkSource: QueueWorkSource = {
  kind: 'markdown',

  async discover(repoRoot, query) {
    const documents = await discoverPlanQueueDocuments(repoRoot, query.kind, query.glob);
    return documents.map((document): WorkCandidate => ({ ref: document.path, readiness: document.readiness, reason: document.reason }));
  },
  resolveRef: (run, reported) => path.resolve(run.workspaceCwd, reported),
  awaitsPlan: candidate => candidate.readiness === 'not-ready' && candidate.ref.toLowerCase().endsWith('_spec.md'),
  // A plan too big for one job runs one job per step; without step headings it stays too big.
  stepJobs: (candidate, run) => (run.kind === 'plans' && oversizedNote(candidate.ref) ? stepsToRun(candidate.ref) : null),
  leftOutNote: (candidate, run, store, section) =>
    (section === null && run.kind === 'plans' ? oversizedNote(candidate.ref) : null) ?? repeatedStopNote(store, candidate.ref, section),
  rememberedOutcome: (candidate, run, memory) => rememberedOutcomeForPath(memory, candidate.ref, run.workspaceCwd),
  reconcileWaiting: (host, run) => reconcileWaitingDocuments(host, run),
  missingNote: (item, run) => missingDocumentNote(item.sourceRef, run.workspaceCwd),
  // Files on disk are always there to read; nothing outside the app can make a markdown run wait.
  reasonToHold: () => null,

  reviewFingerprint: item => readDocumentReview(item.sourceRef),
  contentHash: item => documentContentSha256(item.sourceRef),
  readPin: (item, recordedAt) => readPlanPin(item, recordedAt),
  isLarge: item => isLargeQueueDocument(item.sourceRef),
  trimAtCheckpoint: (item, memory) => dietAtCheckpoint(item, memory),
  workerPrompts: markdownWorkerPrompts,
  stepUpInstruction: (failedRounds, findings) => buildStepUpInstruction(failedRounds, findings),
  async checkerPrompt({ run, item, baseBranch, receipts, diffStat, earlierRounds, pin, directChanges }) {
    const current = (await fs.readFile(item.sourceRef)).toString('utf8');
    const relative = path.relative(run.workspaceCwd, item.sourceRef);
    const documentDiff = item.baseCommit && !relative.startsWith('..')
      ? await gitExec(['diff', `${item.baseCommit}..HEAD`, '--', relative], item.worktreePath!) : '';
    return buildVerifierPrompt({ item, kind: run.kind, repoRoot: run.workspaceCwd, worktreePath: item.worktreePath!, baseBranch,
      gates: run.config.verifierGates, receipts,
      // The checker reads the plan's Status and open work and a change summary, then sections by line range.
      diffStat: bounded(diffStat, PLAN_BRIEF_BYTES, '[Change summary truncated. Run git diff --stat for the rest.]'),
      ...(run.kind === 'plans' ? { brief: await readPlanBrief(item.sourceRef, item.section) } : {}),
      directChanges,
      earlierRounds,
      documentChanges: pin ? JSON.stringify({ originalHash: pin.documentSha256, originalUnchecked: pin.unchecked,
        changes: comparePinnedUnchecked(pin.unchecked, extractChecklistItems(current, 'all')), diff: documentDiff }) : undefined });
  },

  landingProblem: item => (item.section == null ? Promise.resolve(null) : stepPlanProblem(item.sourceRef)),
  async noteOpenLanding(item, run, jobsOfRun) {
    // A plan that stays open says whether its work is on main; a closed one carries that in its closed copy. Live-test documents have no such line.
    if (run.kind !== 'plans') return [];
    try { await updatePlanIntegrationStatus(item.sourceRef, item.branchName ?? '', item.landedCommit!, item.section, finishesPlan(jobsOfRun(), item)); return []; }
    catch (error) { return [`Code landed, but the plan's "On main" line could not be updated: ${error instanceof Error ? error.message : String(error)}`]; }
  },
  setAsideView: async (item, folder) => ({ document: path.relative(folder, item.sourceRef), documentState: await documentState(item.sourceRef) }),
  rowTitle: () => null,

  appendParkNote: (item, run, reason, history) => appendParkedBranchNote(item, run, reason, history),
  removeParkNote: (item, branchName) => removeParkedNote(item.sourceRef, branchName),

  async assertUnchangedSince(item, reviewed) { assertDocumentReview(await readDocumentReview(item.sourceRef), reviewed); },
  async prepareClose(item, repoRoot, worktreePath, reviewed) {
    await assertNoOtherUnlandedWork(item.sourceRef, item.branchName ?? '');
    return prepareClosedDocuments(item.sourceRef, repoRoot, worktreePath, reviewed);
  },
  async finishClose(item, repoRoot, baseBranch, reviewed) {
    if (await documentsAreCommitted(item.sourceRef, repoRoot)) {
      try {
        return await retireActiveDocuments(item.sourceRef, repoRoot, baseBranch, reviewed);
      } catch (error) {
        throw new Error(`The closed documents landed with the code; removing the old root copies failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    // Never committed (outside the repository or ignored): close in place,
    // revalidating the accepted bytes rather than adopting a later snapshot.
    try {
      await renameDocumentsInPlace(item.sourceRef, reviewed, item.landedCommit!);
      return [];
    } catch (error) {
      throw new Error(`Code landed, but the uncommitted documents remain open: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  },

  overlapResolver: itemId => createDocumentOverlapResolver({ itemId }),
  resolveSyncConflict: (worktreePath, conflictFiles) => resolveRegisterClash(worktreePath, conflictFiles),
  rootEditWouldMerge: (repoRoot, baseTip, itemHead, file) => rootEditWouldMerge(repoRoot, baseTip, itemHead, file),
  recoverLandingMerge: (repoRoot, itemId) => recoverDocumentMergeForItem(repoRoot, itemId),
  recoverInterruptedMerges: store => recoverInterruptedDocumentMerges(store),

  displayName: item => stem(item.sourceRef),
  branchSlug: item => stem(item.sourceRef).replace(/_(plan|livetest)$/i, ''),
  fullName: item => path.basename(item.sourceRef),
  checkpointTrailer: item => `Document: ${item.sourceRef}`,
  commitSubject: (item, run) => `${run.kind === 'livetests' ? 'Livetest' : 'Plan'}: ${stem(item.sourceRef)}${item.section == null ? '' : ` (Step ${item.section})`}`,
};

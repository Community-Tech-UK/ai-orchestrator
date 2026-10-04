/** Readiness decisions and lifecycle reconciliation before any work starts. */
import { lstat } from 'fs/promises';
import * as path from 'path';
import {
  PlanQueueQuestionSchema,
  type PlanQueueItemState,
  type PlanQueueQuestion,
  type PlanQueueReportTriageArgs,
} from '@contracts/schemas/plan-queue';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { buildQuestionsMessage, withSkipOption } from './plan-queue-messages';
import type { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

export const PRE_START_STATES = new Set<PlanQueueItemState>(['discovered', 'needs-answer', 'queued']);
type ReadinessHost = Pick<PlanQueueFlowHost, 'getRun' | 'getItem' | 'transition' | 'notifyParent'> & {
  readonly store: PlanQueueStore;
};

/** Metadata is untrusted input: invalid or legacy questions never select an option. */
export function automaticDecisionPatch(question: PlanQueueQuestion): Partial<PlanQueueItem> | null {
  const parsed = PlanQueueQuestionSchema.safeParse(question);
  if (!parsed.success || parsed.data.decision?.kind !== 'technical') return null;
  const decision = parsed.data.decision;
  const option = parsed.data.options.find((candidate) => candidate.id === decision.recommendedOptionId)!;
  const answer = `Automatic technical decision: ${option.id} — ${option.label}\nQuestion: ${parsed.data.question.slice(0, 400)}\nReason: ${decision.reason.slice(0, 450)}\nEvidence: ${decision.evidence.slice(0, 450)}`;
  return {
    question: null,
    answer,
    detail: `Automatic technical decision (no new authority): ${option.id} — ${option.label}\nQuestion: ${parsed.data.question.slice(0, 1000)}\nReason: ${decision.reason.slice(0, 1500)}\nEvidence: ${decision.evidence.slice(0, 4500)}`,
  };
}

/** Caller authorization stays in the coordinator; apply each record to its current row. */
export function applyTriageRecords(host: ReadinessHost, run: PlanQueueRun, args: PlanQueueReportTriageArgs): { applied: number; unmatched: string[] } {
  const byPath = new Map(host.store.listItems(run.id).map((item) => [path.resolve(item.documentPath), item.id]));
  const unmatched: string[] = [];
  let applied = 0;
  let asked = false;
  for (const record of args.records) {
    const id = byPath.get(path.resolve(run.workspaceCwd, record.documentPath));
    const item = id ? host.getItem(id) : undefined;
    const currentRun = host.getRun(run.id);
    if (!item || item.state !== 'discovered' || (currentRun.status !== 'running' && currentRun.status !== 'paused')) {
      unmatched.push(record.documentPath);
      continue;
    }
    if (record.disposition === 'ready') host.transition(item, 'queued');
    else if (record.disposition === 'skip') host.transition(item, 'skipped', { detail: record.reason });
    else {
      const question = withSkipOption(PlanQueueQuestionSchema.parse(record.question));
      const automatic = automaticDecisionPatch(question);
      if (automatic) host.transition(item, 'queued', automatic);
      else {
        host.transition(item, 'needs-answer', { question });
        asked = true;
      }
    }
    applied += 1;
  }
  if (asked) {
    const questions = host.store.listItems(run.id).filter((item) => item.state === 'needs-answer' && item.question);
    host.notifyParent(host.getRun(run.id), buildQuestionsMessage(questions));
  }
  return { applied, unmatched };
}

async function documentExists(documentPath: string): Promise<boolean> {
  try {
    const stat = await lstat(documentPath);
    if (!stat.isFile()) throw new Error('Document is not a regular file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function hasNotStarted(item: PlanQueueItem): boolean {
  return PRE_START_STATES.has(item.state) && !item.branchName && !item.worktreePath;
}

/** Only untouched entries can be retired; branch-owned work is never discarded. */
export async function reconcileWaitingDocuments(host: ReadinessHost, run: PlanQueueRun): Promise<void> {
  for (const snapshot of host.store.listItems(run.id).filter(hasNotStarted)) {
    let outcome: 'present' | 'completed' | 'missing' | 'error';
    let detail: string;
    try {
      const relative = path.relative(run.workspaceCwd, snapshot.documentPath);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error('Document is outside the run workspace');
      }
      if (await documentExists(snapshot.documentPath)) {
        outcome = 'present';
        detail = '';
      } else {
        const completed = snapshot.documentPath.replace(/\.md$/i, '_completed.md');
        if (completed !== snapshot.documentPath && await documentExists(completed)) {
          outcome = 'completed';
          detail = `Superseded by exact completed replacement: ${completed}. Queue entry retired; this is not a verification verdict.`;
        } else {
          outcome = 'missing';
          detail = `Source document is missing and has no exact completed replacement: ${snapshot.documentPath}. Restore or reconcile the document before resuming.`;
        }
      }
    } catch (error) {
      outcome = 'error';
      detail = `Could not inspect source document: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Filesystem awaits allow cancellation, answers and worker starts. Never write a stale row.
    const currentRun = host.getRun(run.id);
    const item = host.getItem(snapshot.id);
    if (!['running', 'paused'].includes(currentRun.status) || !hasNotStarted(item)
      || item.documentPath !== snapshot.documentPath) continue;
    if (outcome === 'completed') host.transition(item, 'skipped', { question: null, detail: detail.slice(0, 8000) });
    else if (outcome !== 'present') host.transition(item, 'parked', { question: null, parkReason: 'worker-error', detail: detail.slice(0, 8000) });
    else if (item.state === 'needs-answer' && item.question) {
      const automatic = automaticDecisionPatch(item.question);
      if (automatic) host.transition(item, 'queued', automatic);
    }
  }
}

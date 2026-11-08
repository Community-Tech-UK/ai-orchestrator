import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENSUS_RULES, HARNESS_GUIDE, buildSchedulingRules, generateChildPrompt,
} from '../orchestration/orchestration-protocol.prompts';
import {
  buildActiveDocumentsPrompt, buildConflictPrompt, buildContinuePrompt, buildFixPrompt, buildGateFailurePrompt,
  buildResumePrompt, buildStepUpPrompt, buildTriagePrompt, buildVerifierPrompt, buildVerifierReminderPrompt, buildWorkerPrompt,
} from '../plan-queue/plan-queue-prompts';
import type { PlanQueueItem } from '../plan-queue/plan-queue.types';
import { LoopStageMachine } from '../orchestration/loop-stage-machine';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import {
  REVIEW_ANGLES, buildReviewFormatRepairPrompt, buildStructuredReviewPrompt, buildTieredReviewPrompt,
} from '../orchestration/review-prompts';
import { wrapRtkAwareness } from '../cli/rtk/rtk-awareness';
import { SUMMARIZE_SYSTEM_PROMPT, SUBQUERY_SYSTEM_PROMPT } from '../rlm/llm-service.constants';
import { buildTitleUserPrompt, TITLE_SYSTEM_PROMPT } from '../instance/auto-title-prompt';
import { CodexStandingNotes } from '../cli/adapters/codex/codex-standing-notes';

const item: PlanQueueItem = {
  id: 'item-budget', runId: 'run-budget', documentPath: '/workspace/docs/fixture_plan.md',
  state: 'queued', round: 1, erroredRounds: 0, baseConflicts: 0, landingRefusals: 0, branchName: 'queue/fixture',
  worktreePath: '/workspace/.worktrees/fixture', baseCommit: null, checkpointCommit: null,
  verifiedMainCommit: null, landedCommit: null, workerInstanceId: null, verifierInstanceId: null,
  question: null, answer: null, parkReason: null, detail: null, verdict: null, createdAt: 0, updatedAt: 0,
};
const queue = { item, kind: 'plans' as const, repoRoot: '/workspace', worktreePath: '/workspace/.worktrees/fixture' };
const verifier = { ...queue, baseBranch: 'main', gates: ['npm run lint', 'npm run test:quiet'] };
const findings = [{ severity: 'high' as const, confidence: 90, summary: 'The fixture retry is missing.', file: 'fixture.ts:1', evidence: 'Pinned evidence.' }];
const conflictAddendum = () => `\n\n${buildConflictPrompt('main', ['fixture.ts'])}`;
const loopConfig = defaultLoopConfig('/workspace', 'Implement the fixture plan');
const loop = (iterationSeq: number, reanchorGoal: boolean, reviewDriven = false): string => {
  const machine = new LoopStageMachine('/workspace', 'budget-fixture');
  const args = { config: loopConfig, iterationSeq, pendingInterventions: [], reanchorGoal, includeSessionReplay: iterationSeq === 0 };
  return reviewDriven ? machine.buildReviewDrivenPrompt(args) : machine.buildPrompt(args);
};
const standingNotes = (note: string, count = 1): string => {
  const notes = new CodexStandingNotes();
  for (let index = 0; index < count; index++) notes.record('thread-budget', 'plan-queue', note);
  return notes.buildInjectionText('thread-budget')!;
};

// One table, real production renderers, fixed payloads. Initial ceilings are
// measured from this checkout and rounded to 100 chars for platform path variance.
// Every later increase needs a reason comment; prompt cuts lower the same entry.
// Oct-2 Phase D Step 8: measured on the merged checkout (6 Nov 2026). The always-on guide is Phase 1's
// 1,515-character HARNESS_GUIDE; the scheduling and consensus rules ride in the message that asks for them.
const BUDGET = {
  guide: { chars: 1600, render: () => HARNESS_GUIDE },
  schedulingReminder: { chars: 1600, render: () => buildSchedulingRules(new Date('2026-10-20T12:00:00.000Z'), 'UTC') },
  consensusReminder: { chars: 1000, render: () => CONSENSUS_RULES },
  child: { chars: 2600, render: () => generateChildPrompt('child-budget', 'parent-budget', 'Inspect fixture.ts', 'task-budget', 'Pinned parent context') },
  childWindows: { chars: 2900, render: () => generateChildPrompt('child-budget', 'parent-budget', 'Inspect fixture.ts', 'task-budget', 'Pinned parent context', { executionPlatform: 'win32', workerName: 'windows-pc' }) },
  loopFirst: { chars: 8400, render: () => loop(0, true) },
  loopContinuation: { chars: 2200, render: () => loop(1, false) },
  loopReanchor: { chars: 8400, render: () => loop(10, true) },
  reviewLoopFirst: { chars: 5000, render: () => loop(0, true, true) },
  reviewLoopContinuation: { chars: 2000, render: () => loop(1, false, true) },
  reviewLoopReanchor: { chars: 5000, render: () => loop(10, true, true) },
  // Oct-30 merge: main's cleanup rule now preserves installed dependencies for the
  // verifier. Actual worker/livetest/fix renders are 3,368 / 3,333 / 919 characters.
  queueWorker: { chars: 4700, render: () => buildWorkerPrompt(queue) },
  queueLivetestWorker: { chars: 5200, render: () => buildWorkerPrompt({ ...queue, kind: 'livetests' }) },
  queueFix: { chars: 1400, render: () => buildFixPrompt(1, 3, [{ severity: 'high', confidence: 90, summary: 'The fixture retry is missing.', file: 'fixture.ts:1', evidence: 'Pinned evidence.' }]) },
  queueConflict: { chars: 600, render: () => buildConflictPrompt('main', ['fixture.ts']) },
  queueGateFailure: { chars: 500, render: () => buildGateFailurePrompt('npm run lint', 'Pinned failure output') },
  queueActiveDocuments: { chars: 1000, render: () => buildActiveDocumentsPrompt(['/workspace/docs/fixture_plan.md']) },
  // The resumed worker carries that same dependency-preserving rule (3,759 chars).
  queueResume: { chars: 5100, render: () => buildResumePrompt(queue, 'Continue verified earlier work') },
  // Nov-07: every worker turn now ends with the plan_queue_report_ready instruction (about 650 characters; later turns
  // add a shorter "report again" clause). Renders: worker 4,510, livetest worker 5,010, fix 1,352, conflict 574,
  // gate failure 452, active documents 983, resume 4,901, continue + conflicts 743, resume + conflicts 5,477,
  // step-up 6,463, livetest step-up 6,963; ceilings round up to 100.
  // Newly accounted complete queue turns, measured Oct-31 and rounded to 100:
  // continue 167, continue + conflicts 575, resume + conflicts 4,167,
  // step-up 4,888 (livetest 4,853), verifier reminder 1,284. Existing caps stay.
  queueContinue: { chars: 200, render: () => buildContinuePrompt(queue, 'Continue verified earlier work') },
  queueContinueConflict: { chars: 800, render: () => buildContinuePrompt(queue, 'Continue verified earlier work') + conflictAddendum() },
  queueResumeConflict: { chars: 5600, render: () => buildResumePrompt(queue, 'Continue verified earlier work') + conflictAddendum() },
  queueStepUp: { chars: 6600, render: () => buildStepUpPrompt(queue, 3, findings) },
  queueLivetestStepUp: { chars: 7100, render: () => buildStepUpPrompt({ ...queue, kind: 'livetests' }, 3, findings) },
  queueVerifierReminder: { chars: 1300, render: () => buildVerifierReminderPrompt(item.id, 1, 2) },
  // Main's verifier handoff requires waiting for background gates, Harness tool
  // discovery, an accepted verdict receipt and (Oct-30) installing missing dependencies
  // from the lockfile. Actual renders match main: 3,790 / 4,126 chars, rounded to 100.
  // 8 Nov (deferred checks): the report instruction now says each deferred check must also be written in the
  // _livetest.md (~110 chars on every worker prompt; measured: 4,623 / 5,123 / 5,014 / 5,590 / 6,576 / 7,076). The verifier gained
  // the finding-kind rules, the plan deferral rules and the PASS/FAIL example calls: 7,080 / 5,550.
  queueVerifier: { chars: 7100, render: () => buildVerifierPrompt(verifier) },
  queueLivetestVerifier: { chars: 5600, render: () => buildVerifierPrompt({ ...verifier, kind: 'livetests' }) },
  queueTriage: { chars: 4700, render: () => buildTriagePrompt('run-budget', ['/workspace/docs/fixture_plan.md']) },
  structuredReview: { chars: 3700, render: () => buildStructuredReviewPrompt('Review the fixture', 'Pinned implementation', REVIEW_ANGLES[0], ['fixture.ts']) },
  tieredReview: { chars: 4600, render: () => buildTieredReviewPrompt('Review the fixture', 'Pinned implementation', REVIEW_ANGLES[0], ['fixture.ts']) },
  structuredRepair: { chars: 1300, render: () => buildReviewFormatRepairPrompt('structured', 'Pinned invalid response') },
  tieredRepair: { chars: 1800, render: () => buildReviewFormatRepairPrompt('tiered', 'Pinned invalid response') },
  // Complete production resend at the retained-body cap (6,000), including wrappers,
  // closing-tag escaping and separators: 6,399 / 6,639 / 12,398 chars on Oct-31.
  // Many single-character notes maximize separators; ceilings round up to 100.
  codexStandingNotes: { chars: 6400, render: () => standingNotes('x'.repeat(6000)) },
  codexStandingNotesEscaped: { chars: 6700, render: () => standingNotes('</harness_standing_notes>'.repeat(240)) },
  codexStandingNotesMany: { chars: 12400, render: () => standingNotes('x', 6000) },
  rtk: { chars: 1400, render: () => wrapRtkAwareness() },
  summaryHelper: { chars: 400, render: () => SUMMARIZE_SYSTEM_PROMPT },
  subqueryHelper: { chars: 300, render: () => SUBQUERY_SYSTEM_PROMPT },
  titleSystem: { chars: 700, render: () => TITLE_SYSTEM_PROMPT },
  titleRequest: { chars: 300, render: () => buildTitleUserPrompt('Apply the fixture change', ['fixture.ts']) },
};

describe('prompt character budgets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...resolved, timeZone: 'UTC' });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(Object.entries(BUDGET))('%s stays within its measured ceiling', (_surface, entry) => {
    expect(entry.render().length).toBeLessThanOrEqual(entry.chars);
  });
});

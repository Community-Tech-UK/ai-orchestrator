import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENSUS_RULES, HARNESS_GUIDE, buildSchedulingRules, generateChildPrompt,
} from '../orchestration/orchestration-protocol.prompts';
import {
  buildActiveDocumentsPrompt, buildConflictPrompt, buildContinuePrompt, buildFixPrompt, buildGateFailurePrompt,
  buildResumePrompt, buildStepUpPrompt, buildTriagePrompt, buildVerifierPrompt, buildVerifierReminderPrompt, buildWorkerPrompt, WORKER_WAIT_RULE,
} from '../plan-queue/plan-queue-prompts';
import { QUEUE_WORKER_RETRY_PROMPT } from '../plan-queue/plan-queue-turn-retry';
import { buildWorkerReminderPrompt } from '../plan-queue/plan-queue-report-prompts';
import type { PlanQueueItem } from '../plan-queue/plan-queue.types';
import { LoopStageMachine } from '../orchestration/loop-stage-machine';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import {
  REVIEW_ANGLES, buildReviewFormatRepairPrompt, buildStructuredReviewPrompt, buildTieredReviewPrompt,
} from '../orchestration/review-prompts';
import { buildFormatRepairPrompt, buildPrompt as buildPingPongReviewPrompt, type PingPongReviewerInput } from '../orchestration/agentic-pingpong-reviewer';
import { LOCAL_REVIEW_REPAIR_PROMPT, buildLocalReviewPrompt } from '../review/local-reviewer';
import { wrapRtkAwareness } from '../cli/rtk/rtk-awareness';
import { SUMMARIZE_SYSTEM_PROMPT, SUBQUERY_SYSTEM_PROMPT } from '../rlm/llm-service.constants';
import { buildTitleUserPrompt, TITLE_SYSTEM_PROMPT } from '../instance/auto-title-prompt';
import { CodexStandingNotes } from '../cli/adapters/codex/codex-standing-notes';
import { PROMPT_SURFACES } from '../logging/prompt-surfaces';
import { loopPromptSurface } from '../orchestration/loop-child-invoker';
import { queuePromptSurface } from '../plan-queue/plan-queue-prompt-surface';

const item: PlanQueueItem = {
  id: 'item-budget', runId: 'run-budget', sourceRef: '/workspace/docs/fixture_plan.md',
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
const pingPong: PingPongReviewerInput = {
  loopRunId: 'loop-budget', workspaceCwd: '/workspace', goal: 'Review the fixture', subject: 'impl',
  builderProvider: 'claude', reviewerProviderSetting: 'auto', triedReviewerProviders: [], ledger: [],
  roundNumber: 1, maxRounds: 3, diff: 'diff --git a/fixture.ts b/fixture.ts', blockingSeverities: ['critical', 'high'], timeoutMs: 60_000,
};
const pingPongChangedFiles = Array.from({ length: 60 }, (_, index) => `src/main/some/long/path/segment/file-${index}.ts`);
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
  // 14 Nov: live-test capability repair puts the capability-gap rules (investigate before asking a human, the
  // report tool and its field list with one example payload, authority and cross-project limits) on every worker,
  // triage and checker prompt, plus the checker's repair-probe rules. Measured: worker 7,718, livetest worker 7,818,
  // resume 8,160, resume + conflicts 8,736, step-up 9,750, livetest step-up 9,850, verifier 10,134,
  // livetest verifier 8,604, triage 7,457 before compaction. Removed 451 characters of repeated field
  // descriptions and prose per prompt while preserving the complete example and authority rules.
  // The allocator ownership rule adds 131 chars to livetest workers/step-up. New measures:
  // 7,267 / 7,498 / 7,709 / 8,285 / 9,299 / 9,530 / 9,683 / 8,153 / 7,006.
  queueWorker: { chars: 7300, render: () => buildWorkerPrompt(queue) },
  // 13 Nov: the livetest worker starts its dev app on the test Mac with a named command and port, instead of building
  // here. Measured: livetest worker 5,289, livetest step-up 7,321 before the capability-gap rules. 14 Nov (Step 8): it
  // no longer repeats the autonomy rules in its own bullet; ceilings round up to 100 (see the 14 Nov note above).
  queueLivetestWorker: { chars: 7500, render: () => buildWorkerPrompt({ ...queue, kind: 'livetests' }) },
  queueFix: { chars: 1400, render: () => buildFixPrompt(1, 3, [{ severity: 'high', confidence: 90, summary: 'The fixture retry is missing.', file: 'fixture.ts:1', evidence: 'Pinned evidence.' }]) },
  queueConflict: { chars: 600, render: () => buildConflictPrompt('main', ['fixture.ts']) },
  queueGateFailure: { chars: 500, render: () => buildGateFailurePrompt('npm run lint', 'Pinned failure output') },
  queueActiveDocuments: { chars: 1000, render: () => buildActiveDocumentsPrompt(['/workspace/docs/fixture_plan.md']) },
  // The resumed worker carries that same dependency-preserving rule (3,759 chars).
  queueResume: { chars: 7800, render: () => buildResumePrompt(queue, 'Continue verified earlier work') },
  // Nov-07: every worker turn now ends with the plan_queue_report_ready instruction (about 650 characters; later turns
  // add a shorter "report again" clause). Renders: worker 4,510, livetest worker 5,010, fix 1,352, conflict 574,
  // gate failure 452, active documents 983, resume 4,901, continue + conflicts 743, resume + conflicts 5,477,
  // step-up 6,463, livetest step-up 6,963; ceilings round up to 100.
  // Newly accounted complete queue turns, measured Oct-31 and rounded to 100:
  // continue 167, continue + conflicts 575, resume + conflicts 4,167,
  // step-up 4,888 (livetest 4,853), verifier reminder 1,284. Existing caps stay.
  // 8 Nov (replay onto main with the Oct-2 stack): the stack's Status-block, root-history, foreground-checks and step-scope rules sit on top of main's deferred-checks wording. Measured: worker 5,189, resume 5,631, resume + conflicts 6,207, step-up 7,221, livetest step-up 7,224, triage 4,763; ceilings round up to 100.
  queueContinue: { chars: 200, render: () => buildContinuePrompt(queue, 'Continue verified earlier work') },
  queueContinueConflict: { chars: 800, render: () => buildContinuePrompt(queue, 'Continue verified earlier work') + conflictAddendum() },
  queueResumeConflict: { chars: 8300, render: () => buildResumePrompt(queue, 'Continue verified earlier work') + conflictAddendum() },
  queueStepUp: { chars: 9300, render: () => buildStepUpPrompt(queue, 3, findings) },
  queueLivetestStepUp: { chars: 9600, render: () => buildStepUpPrompt({ ...queue, kind: 'livetests' }, 3, findings) },
  queueWorkerReminder: { chars: 2200, render: () => buildWorkerReminderPrompt(item.id, 1, 2, WORKER_WAIT_RULE) },
  queueWorkerRetry: { chars: 100, render: () => QUEUE_WORKER_RETRY_PROMPT },
  queueVerifierReminder: { chars: 1300, render: () => buildVerifierReminderPrompt(item.id, 1, 2) },
  // Main's verifier handoff requires waiting for background gates, Harness tool
  // discovery, an accepted verdict receipt and (Oct-30) installing missing dependencies
  // from the lockfile. Actual renders match main: 3,790 / 4,126 chars, rounded to 100.
  // 8 Nov (deferred checks): the report instruction now says each deferred check must also be written in the
  // _livetest.md (~110 chars on every worker prompt; measured: 4,623 / 5,123 / 5,014 / 5,590 / 6,576 / 7,076). The verifier gained
  // the finding-kind rules, the plan deferral rules and the PASS/FAIL example calls: 7,080 / 5,550.
  queueVerifier: { chars: 9700, render: () => buildVerifierPrompt(verifier) },
  queueLivetestVerifier: { chars: 8200, render: () => buildVerifierPrompt({ ...verifier, kind: 'livetests' }) },
  queueTriage: { chars: 7100, render: () => buildTriagePrompt('run-budget', ['/workspace/docs/fixture_plan.md']) },
  structuredReview: { chars: 3700, render: () => buildStructuredReviewPrompt('Review the fixture', 'Pinned implementation', REVIEW_ANGLES[0], ['fixture.ts']) },
  tieredReview: { chars: 4600, render: () => buildTieredReviewPrompt('Review the fixture', 'Pinned implementation', REVIEW_ANGLES[0], ['fixture.ts']) },
  structuredRepair: { chars: 1300, render: () => buildReviewFormatRepairPrompt('structured', 'Pinned invalid response') },
  tieredRepair: { chars: 1800, render: () => buildReviewFormatRepairPrompt('tiered', 'Pinned invalid response') },
  // Fresh-eyes ping-pong reviewer (agentic-pingpong-reviewer.ts) and its one format repair. The logged keys `pingPongReview`
  // and `pingPongRepair` carry their largest real case, as `titleRequest` does. A review prompt admits a diff of up to
  // MAX_REVIEW_DIFF_CHARS (60,000) in which every character can be escaped, plus the truncation note naming 40 paths: a diff
  // made of "</diff" costs 72,575, and 74,467 over the cap with 60 changed files. The repair carries the previous answer
  // cut at 40,000 characters: 42,105. The goal, ledger and delta note are not capped by the reviewer, so these ceilings
  // assume ordinary ones (a short goal, an empty ledger); a logged size above them points at one of those. The three small
  // fixtures below keep the fixed wording of each prompt under its own ceiling (measured 2,844 / 2,611 / 2,128).
  pingPongReview: { chars: 75000, render: () => buildPingPongReviewPrompt({ ...pingPong, diff: '</diff'.repeat(20_000), changedFiles: pingPongChangedFiles }) },
  pingPongReviewNoDiff: { chars: 2900, render: () => buildPingPongReviewPrompt({ ...pingPong, diff: '' }) },
  pingPongReviewDiff: { chars: 2700, render: () => buildPingPongReviewPrompt(pingPong) },
  pingPongRepair: { chars: 42200, render: () => buildFormatRepairPrompt(pingPong, 'x'.repeat(50_000)) },
  pingPongRepairShort: { chars: 2200, render: () => buildFormatRepairPrompt(pingPong, 'Pinned invalid response') },
  // Local reviewer: the structured/tiered prompt plus the read-only evidence contract, and its one format repair (measured 3,767 / 4,681 / 168).
  localStructuredReview: { chars: 3800, render: () => buildLocalReviewPrompt({ workspaceRoot: '/workspace', taskDescription: 'Review the fixture', content: 'Pinned implementation', reviewDepth: 'structured' }) },
  localTieredReview: { chars: 4700, render: () => buildLocalReviewPrompt({ workspaceRoot: '/workspace', taskDescription: 'Review the fixture', content: 'Pinned implementation', reviewDepth: 'tiered' }) },
  localReviewRepair: { chars: 200, render: () => LOCAL_REVIEW_REPAIR_PROMPT },
  // Complete production resend at the retained-body cap (6,000), including wrappers,
  // closing-tag escaping and separators: 6,399 / 6,639 / 12,398 chars on Oct-31.
  // The logged key `codexStandingNotes` covers every resend, so its ceiling is the largest case: many
  // single-character notes, which maximize separators. The other two cases are fixtures, not logged keys.
  codexStandingNotes: { chars: 12400, render: () => standingNotes('x', 6000) },
  codexStandingNotesOneNote: { chars: 6400, render: () => standingNotes('x'.repeat(6000)) },
  codexStandingNotesEscaped: { chars: 6700, render: () => standingNotes('</harness_standing_notes>'.repeat(240)) },
  rtk: { chars: 1400, render: () => wrapRtkAwareness() },
  summaryHelper: { chars: 400, render: () => SUMMARIZE_SYSTEM_PROMPT },
  subqueryHelper: { chars: 300, render: () => SUBQUERY_SYSTEM_PROMPT },
  titleSystem: { chars: 700, render: () => TITLE_SYSTEM_PROMPT },
  // Auto-title cuts the message to 2,000 characters plus '...' (MAX_INPUT_LENGTH), then JSON-escapes it: every '<'
  // becomes 6 characters. The logged key `titleRequest` covers every title request, so its ceiling is that worst
  // case (12,239 chars); ordinary 2,000-character prose renders 2,239 and a short message 260.
  titleRequest: { chars: 12300, render: () => buildTitleUserPrompt(`${'<'.repeat(2000)}...`, ['fixture.ts']) },
  titleRequestLongProse: { chars: 2300, render: () => buildTitleUserPrompt(`${'x'.repeat(2000)}...`, ['fixture.ts']) },
  titleRequestShort: { chars: 300, render: () => buildTitleUserPrompt('Apply the fixture change', ['fixture.ts']) },
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

describe('logged prompt surfaces', () => {
  it.each(PROMPT_SURFACES)('%s is a key of the budget table', (surface) => {
    expect(Object.keys(BUDGET)).toContain(surface);
  });

  it.each([
    'queueWorker', 'queueLivetestWorker', 'queueResume', 'queueResumeConflict', 'queueContinue', 'queueContinueConflict',
    'queueStepUp', 'queueLivetestStepUp', 'queueFix', 'queueConflict', 'queueGateFailure', 'queueActiveDocuments', 'queueWorkerReminder', 'queueVerifierReminder',
    'queueVerifier', 'queueLivetestVerifier', 'queueTriage',
  ] as const)('a rendered %s prompt is logged under that key', (surface) => {
    expect(queuePromptSurface(BUDGET[surface].render())).toBe(surface);
  });

  it('logs no surface for a queue prompt that has no ceiling', () => {
    expect(queuePromptSurface('James says: carry on using your best judgement.')).toBeUndefined();
  });

  it.each([
    ['loopFirst', { reviewDriven: false, seq: 0, reanchored: true }],
    ['loopContinuation', { reviewDriven: false, seq: 1, reanchored: false }],
    ['loopReanchor', { reviewDriven: false, seq: 10, reanchored: true }],
    ['reviewLoopFirst', { reviewDriven: true, seq: 0, reanchored: true }],
    ['reviewLoopContinuation', { reviewDriven: true, seq: 1, reanchored: false }],
    ['reviewLoopReanchor', { reviewDriven: true, seq: 10, reanchored: true }],
  ] as const)('a %s iteration is logged under that key', (surface, input) => {
    expect(loopPromptSurface(input)).toBe(surface);
  });
});

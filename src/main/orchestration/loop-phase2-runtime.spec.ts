import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auditRuntime from './loop-audit-runtime';
import * as freshEyes from './loop-fresh-eyes-reviewer';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { unknownAttemptEvidence } from './loop-invocation-attempt';

let cwd: string; let coordinator: LoopCoordinator;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(),'loop-phase2-')); coordinator = new LoopCoordinator(); coordinator.setCleanReviewClassifier(async () => ({ clean: false, confidence: 1, reason: 'still editing' })); });
afterEach(async () => { for (const loop of coordinator.getActiveLoops()) await coordinator.cancelLoop(loop.id); vi.restoreAllMocks(); rmSync(cwd,{ recursive: true, force: true }); });
const result = (): LoopChildResult => ({ childInstanceId: null, output: 'Still making small edits.', tokens: 1, filesChanged: [{ path: 'src/a.ts', additions: 1, deletions: 0, contentHash: 'a' }], toolCalls: [], errors: [], testPassCount: null, testFailCount: null, exitedCleanly: true });
async function waitUntil(predicate: () => boolean): Promise<void> { const start = Date.now(); while (!predicate()) { if (Date.now()-start>12_000) throw new Error('Timed out waiting for runtime'); await new Promise(resolve=>setTimeout(resolve,20)); } }
describe('Phase2 coordinator runtime', () => {
  it.each(['paused', 'cancelled'] as const)('honors %s while a ping-pong final audit is downgrading approval', async status => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    writeFileSync(join(cwd, 'a.ts'), 'before\n'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    let finishAudit: (value: Awaited<ReturnType<typeof auditRuntime.runLoopFinalAudit>>) => void = () => undefined;
    const audit = vi.spyOn(auditRuntime, 'runLoopFinalAudit').mockImplementation(() => new Promise(resolve => { finishAudit = resolve; }));
    vi.spyOn(freshEyes, 'runLocalOnlyFreshEyesReview').mockResolvedValue({ status: 'skipped', findings: [], summary: 'off' });
    coordinator.setCleanReviewClassifier(async () => ({ clean: true, confidence: 1, reason: 'reviewed' }));
    coordinator.setPingPongReviewerForTesting(async () => ({ verdict: 'APPROVED', reviewerProvider: 'codex', findings: [], ledgerClassifications: [], summary: 'approved', tokensUsed: 0, costCents: 0 }));
    coordinator.on('loop:invoke-iteration', (payload: { callback: (value: LoopChildResult) => void }) => queueMicrotask(() => payload.callback({ ...result(), filesChanged: [], output: 'There are no outstanding issues' })));
    const ended = vi.fn(); coordinator.on('loop:completed-needs-review', ended);
    const base = defaultLoopConfig(cwd, 'Implement one task');
    const state = await coordinator.startLoop('audit-control-chat', { ...base, audit: { ...base.audit, finalAuditMode: 'gate' }, completion: { ...base.completion, mode: 'review-driven', verifyCommand: 'true', crossModelReview: { enabled: true, blockingSeverities: ['critical', 'high'], timeoutSeconds: 10, reviewDepth: 'structured', pingPong: { enabled: true, maxRounds: 3, subject: 'impl' } } } });
    await waitUntil(() => audit.mock.calls.length > 0);
    if (status === 'paused') expect(coordinator.pauseLoop(state.id)).toBe(true);
    else await coordinator.cancelLoop(state.id);
    finishAudit({ status: 'needs-review', ranAt: Date.now(), findings: [], changedFiles: [], coverage: { criteriaTotal: 0, criteriaVerified: 0, criteriaUnverified: 0, verifyCommandRan: true, repoComparisonRan: true, cleanlinessScanRan: true } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(coordinator.getLoop(state.id)?.status).toBe(status);
    expect(ended).not.toHaveBeenCalled();
  }, 20_000);
  it.each(['gated', 'review-driven'] as const)('reviewer spend stops %s completion at the cap and retains its last round', async mode => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    writeFileSync(join(cwd, 'a.ts'), 'before\n'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    writeFileSync(join(cwd, 'a.ts'), 'after\n');
    coordinator.setCleanReviewClassifier(async () => ({ clean: true, confidence: 1, reason: 'reviewed' }));
    coordinator.setFreshEyesReviewer(async () => ({ findings: [], reviewersUsed: ['codex'], summary: 'approved', tokensUsed: 20, costCents: 20 }));
    coordinator.on('loop:invoke-iteration', (payload: { loopRunId: string; callback: (value: LoopChildResult) => void }) => {
      writeFileSync(join(resolveLoopArtifactPaths(cwd, payload.loopRunId).dir, 'DONE.txt'), 'finished\n');
      queueMicrotask(() => payload.callback({ ...result(), filesChanged: [], costUsd: 0, output: 'There are no outstanding issues\n<promise>DONE</promise>' }));
    });
    const base = defaultLoopConfig(cwd, 'Implement one task');
    const state = await coordinator.startLoop('review-cap-chat', { ...base, caps: { ...base.caps, maxCostCents: 10 }, completion: { ...base.completion, mode, verifyCommand: 'true', runVerifyTwice: false, crossModelReview: { enabled: true, blockingSeverities: ['critical', 'high'], timeoutSeconds: 10, reviewDepth: 'structured' } } });
    await waitUntil(() => coordinator.getLoop(state.id)?.endedAt != null);
    expect(coordinator.getLoop(state.id)).toMatchObject({ status: 'cost-exceeded', totalCostCents: 20, lastIteration: { tokens: 1 } });
  }, 20_000);
  it.each(['## Needs human\n- Which export format?\n  - Recommendation: CSV', '## Decisions applied\n- Publish to production\n  - Applied: Ship now'])('a clean finish keeps a human question visible instead of reporting completed', async question => {
    coordinator.setCleanReviewClassifier(async () => ({ clean: true, confidence: 1, reason: 'reviewed' }));
    coordinator.on('loop:invoke-iteration', (payload: { loopRunId: string; callback: (value: LoopChildResult) => void }) => {
      const files = resolveLoopArtifactPaths(cwd, payload.loopRunId);
      writeFileSync(files.tasks, '# Loop Tasks\n- [x] Implement export <!-- loop-task-id:export -->\n');
      writeFileSync(files.outstanding, question);
      queueMicrotask(() => payload.callback({ ...result(), filesChanged: [], output: 'There are no outstanding issues' }));
    });
    const base = defaultLoopConfig(cwd, 'Implement export');
    const state = await coordinator.startLoop('question-finish-chat', { ...base, audit: { ...base.audit, finalAuditMode: 'off' }, completion: { ...base.completion, mode: 'review-driven', verifyCommand: 'true', runVerifyTwice: false } });
    await waitUntil(() => coordinator.getLoop(state.id)?.endedAt != null);
    expect(coordinator.getLoop(state.id)?.status).toBe('completed-needs-review');
    expect(coordinator.getLoop(state.id)?.endReason).toContain(question.split('\n')[1].slice(2));
  }, 20_000);
  it('a closed ledger bounds a continually editing loop to three finish rounds and preserves skipped-check evidence', async () => {
    let calls = 0;
    coordinator.on('loop:invoke-iteration', (payload: { loopRunId: string; callback: (value: LoopChildResult) => void }) => {
      calls += 1; const taskFile = resolveLoopArtifactPaths(cwd,payload.loopRunId).tasks;
      mkdirSync(dirname(taskFile), { recursive: true }); writeFileSync(taskFile,'# Loop Tasks\n- [x] Implement the goal <!-- loop-task-id:goal -->\n');
      queueMicrotask(()=>payload.callback(result()));
    });
    const base = defaultLoopConfig(cwd,'Implement one task');
    const state = await coordinator.startLoop('finish-chat',{ ...base, completion: { ...base.completion, mode: 'review-driven' }, caps: { ...base.caps, maxIterations: 20 } });
    await waitUntil(()=>coordinator.getLoop(state.id)?.endedAt != null);
    expect(calls).toBe(4);
    expect(coordinator.getLoop(state.id)).toMatchObject({ status: 'completed-needs-review', endEvidence: { mergeHold: true } });
  },20_000);
  it('an interactive unknown attempt pauses and resumes the same step with the check-files instruction', async () => {
    let calls = 0; let resumedPrompt = '';
    coordinator.on('loop:invoke-iteration', (payload: { prompt: string; callback: (value: unknown) => void }) => {
      calls += 1;
      if (calls === 1) queueMicrotask(()=>payload.callback({ error: 'turn timeout', attemptEvidence: unknownAttemptEvidence('turn timeout') }));
      else { resumedPrompt = payload.prompt; queueMicrotask(()=>payload.callback(result())); }
    });
    const base = defaultLoopConfig(cwd,'Implement one task');
    const state = await coordinator.startLoop('pause-chat',{ ...base, onFailedStep: 'pause' });
    await waitUntil(()=>coordinator.getLoop(state.id)?.status === 'paused');
    expect(coordinator.getLoop(state.id)?.endedAt).toBeNull();
    expect(coordinator.getLoop(state.id)?.totalIterations).toBe(0);
    expect(coordinator.resumeLoop(state.id)).toBe(true);
    await waitUntil(()=>calls>=2);
    expect(resumedPrompt).toContain('git status'); expect(resumedPrompt).toContain('git diff');
    expect(coordinator.getLoop(state.id)?.status).toBe('running');
  },20_000);
  it('the same unprovable attempt without an interactive marker has a terminal failure', async () => {
    coordinator.on('loop:invoke-iteration',(payload: { callback: (value: unknown)=>void })=>queueMicrotask(()=>payload.callback({ error: 'turn timeout', attemptEvidence: unknownAttemptEvidence('turn timeout') })));
    const state: LoopState = await coordinator.startLoop('auto-chat', defaultLoopConfig(cwd,'Implement one task'));
    await waitUntil(()=>coordinator.getLoop(state.id)?.endedAt != null);
    expect(coordinator.getLoop(state.id)?.status).toBe('attempt-failed');
  },20_000);
});

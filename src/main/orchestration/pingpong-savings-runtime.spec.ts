import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState, type LoopIteration } from '../../shared/types/loop.types';
import { evaluatePingPongCompletion, type PingPongGateDeps } from './loop-pingpong-completion';
import type { PingPongReviewResult } from './agentic-pingpong-reviewer';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pp-savings-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init','-q'); git('config','user.email','test@example.com'); git('config','user.name','Test');
  writeFileSync(join(cwd, 'a.ts'),'old\n'); writeFileSync(join(cwd,'b.ts'),'old\n'); git('add','.'); git('-c','commit.gpgsign=false','commit','-qm','baseline');
  writeFileSync(join(cwd,'a.ts'),'new\n'); writeFileSync(join(cwd,'b.ts'),'new\n');
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
function deps(): PingPongGateDeps {
  const config = defaultLoopConfig(cwd,'fix'); config.completion.mode = 'review-driven';
  config.completion.crossModelReview = { enabled: true, blockingSeverities: ['critical','high'], reviewDepth: 'structured', timeoutSeconds: 60, pingPong: { enabled: true, maxRounds: 15, subject: 'impl' } };
  return { state: { id: 'pp', config, totalTokens: 0, totalCostCents: 0, pendingInterventions: [], uncompletedPlanFilesAtStart: [] } as unknown as LoopState,
    iteration: { filesChanged: [], completionSignalsFired: [{ id: 'done-promise', sufficient: true, detail: 'done' }], workHash: 'one' } as unknown as LoopIteration,
    seq: 0, stage: 'IMPLEMENT', fullOutput: 'There are no outstanding issues', emit: vi.fn(), classifyCleanReview: async () => ({ clean: true, reason: 'checked', confidence: 1 }), signal: new AbortController().signal, isCancelled: () => false,
    foldReviewerSpend: () => undefined, localAdvisoryReviewer: async () => ({ status: 'skipped', findings: [], summary: 'off' }) };
}
function review(severity: 'high' | 'low' = 'high'): PingPongReviewResult {
  return { verdict: 'CHANGES_REQUESTED', reviewerProvider: 'codex', findings: [{ title: 'Counter defect', severity, evidence: 'a.ts:1', body: 'Counter is not reset.', novelty: 'persisted' }], ledgerClassifications: [], summary: 'one issue', tokensUsed: 0, costCents: 0 };
}
describe('reviewer savings in the real gate', () => {
  it('forwards each cost portion before accepting an approval', async () => {
    const input = deps();
    const spendBreakdown = [{ tokens: 10, costCents: 0, basis: 'unknown' as const }, { tokens: 20, costCents: 40, basis: 'provider-reported' as const }];
    input.reviewer = async () => ({ ...review('low'), tokensUsed: 30, costCents: 40, exactCostCents: 40, spendRecords: 2, costBasis: 'unknown', spendBreakdown });
    input.foldReviewerSpend = vi.fn();
    expect((await evaluatePingPongCompletion(input))?.status).toBe('completed');
    expect(input.foldReviewerSpend).toHaveBeenCalledWith(30, 40, 40, 2, 'unknown', spendBreakdown);
  });
  it('nits converge and reach James as suggestions, never the builder', async () => {
    const input = deps(); input.reviewer = async () => review('low');
    const result = await evaluatePingPongCompletion(input);
    expect(result?.status).toBe('completed'); expect(input.state.pendingInterventions).toEqual([]);
    expect(result?.reason).toContain('1 optional suggestions');
    expect(input.state.pingPong?.ledger).toEqual([]);
  });
  it('skips unchanged review once, but a rebuttal always reaches a fresh reviewer and arbitrate', async () => {
    const input = deps(); input.reviewer = vi.fn(async () => review());
    expect(await evaluatePingPongCompletion(input)).toBeNull();
    expect(input.state.pendingInterventions[0].message).toContain('<review_findings>');
    expect(input.state.pendingInterventions[0].message).toContain('pp-');
    expect(await evaluatePingPongCompletion(input)).toBeNull();
    expect(input.reviewer).toHaveBeenCalledTimes(1);
    const id = input.state.pingPong!.ledger[0].id;
    input.fullOutput = `Finding ${id}: rebutted - the counter is intentionally scoped.\nThere are no outstanding issues`;
    expect((await evaluatePingPongCompletion(input))?.status).toBe('needs-human-arbitration');
    expect(input.reviewer).toHaveBeenCalledTimes(2);
  });
  it('later rounds send changed files and builder claims; unknown and last rounds use full diff', async () => {
    const input = deps(); input.reviewer = vi.fn(async () => review());
    await evaluatePingPongCompletion(input);
    const id = input.state.pingPong!.ledger[0].id;
    writeFileSync(join(cwd,'a.ts'),'newer\n');
    input.fullOutput = `Finding ${id}: fixed - reset after success.\nThere are no outstanding issues`;
    await evaluatePingPongCompletion(input);
    const second = vi.mocked(input.reviewer).mock.calls[1][0];
    expect(second.deltaNote).toContain('a.ts'); expect(second.diff).not.toContain('diff --git a/b.ts');
    expect(second.ledger[0].builderClaim).toBe('fixed');
  });
  it('a reverted reviewed file forces a full packet rather than disappearing from review', async () => {
    const input = deps(); input.reviewer = vi.fn(async () => review());
    await evaluatePingPongCompletion(input);
    const id = input.state.pingPong!.ledger[0].id;
    writeFileSync(join(cwd, 'a.ts'), 'old\n');
    input.fullOutput = `Finding ${id}: fixed - reverted the change.\nThere are no outstanding issues`;
    await evaluatePingPongCompletion(input);
    const second = vi.mocked(input.reviewer).mock.calls[1][0];
    expect(second.diff).toContain('diff --git a/b.ts');
    expect(input.state.pingPong?.lastReviewedFiles?.find(file => file.path === 'a.ts')?.contentHash).toBeDefined();
  });
});

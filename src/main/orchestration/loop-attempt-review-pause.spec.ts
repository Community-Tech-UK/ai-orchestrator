import { describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { handleFailedAttempt, stopRunForFailedAttempt } from './loop-attempt-review-pause';
import { unknownAttemptEvidence } from './loop-invocation-attempt';
import { isTerminalLoopRuntimeStatus } from './loop-runtime-status';

describe('failed loop attempt stopping', () => {
  it('names observed paths when context overflow cannot be replayed over writes', () => {
    const state = { id: 'loop-overflow' } as LoopState;
    const terminate = vi.fn();
    stopRunForFailedAttempt({ state, seq: 0, reason: 'context overflow', terminate,
      evidence: { outcome: 'failed', outputExcerpt: 'context overflow', workspaceEffect: 'writes-observed',
        filesChanged: [{ path: 'src/partial.ts', additions: 1, deletions: 0, contentHash: 'example' }],
        providerThreadReusable: false } });
    expect(terminate).toHaveBeenCalledWith('attempt-failed', expect.stringContaining('src/partial.ts'));
    expect(state.endEvidence).toMatchObject({ workspaceEffect: 'writes-observed', changedPaths: ['src/partial.ts'] });
  });
  it('seals unknown effects into a failed end state without announcing successful review completion', () => {
    const state = { id: 'loop-failed' } as LoopState;
    const terminate = vi.fn();
    stopRunForFailedAttempt({ state, seq: 2, evidence: unknownAttemptEvidence('timed out after 30 minutes'),
      reason: 'timed out after 30 minutes', terminate });
    expect(state.endEvidence).toMatchObject({ workspaceEffect: 'unknown', pausedIterationSeq: 2 });
    expect(terminate).toHaveBeenCalledWith('attempt-failed', expect.stringContaining('Stopped: step 3 failed'));
    expect(terminate.mock.calls[0][1]).toContain('Nothing was merged');
  });
});

describe('failed attempt handling', () => {
  it('unknown unattended attempts stop as failed and never emit a successful end', () => {
    const state = { id: 'failed', config: defaultLoopConfig('/tmp', 'goal'), pendingInterventions: [] } as unknown as LoopState;
    const emit = vi.fn(); const terminate = vi.fn();
    expect(handleFailedAttempt({ state, seq: 2, evidence: unknownAttemptEvidence('timeout'), reason: 'timeout', emit, terminate })).toBe('stopped');
    expect(terminate).toHaveBeenCalledWith('attempt-failed', expect.stringContaining('Step 3'));
    expect(emit).not.toHaveBeenCalledWith('loop:completed-needs-review', expect.anything());
    expect(isTerminalLoopRuntimeStatus('attempt-failed')).toBe(true);
    expect(state.endEvidence?.['workspaceEffect']).toBe('unknown');
  });
  it('interactive attempts pause with STEP_FAILED and check-files direction', () => {
    const state = { id: 'failed', config: { ...defaultLoopConfig('/tmp', 'goal'), onFailedStep: 'pause' }, pendingInterventions: [] } as unknown as LoopState;
    const emit = vi.fn(); const terminate = vi.fn(); const pause = vi.fn(); const notify = vi.fn();
    expect(handleFailedAttempt({ state, seq: 2, evidence: unknownAttemptEvidence('timeout'), reason: 'timeout', emit, terminate, pause, notify })).toBe('paused');
    expect(terminate).not.toHaveBeenCalled(); expect(notify).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledWith(expect.stringContaining('Nothing was merged'), expect.objectContaining({ id: 'STEP_FAILED' }));
    expect(state.pendingInterventions[0]).toMatchObject({ source: 'failed-step', kind: 'queue' });
    expect(state.pendingInterventions[0].message).toContain('git status');
    expect(state.pendingInterventions[0].message).toContain('git diff');
  });
});

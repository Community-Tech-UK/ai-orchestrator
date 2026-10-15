import { describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { handleFailedAttempt } from './loop-attempt-review-pause';
import { unknownAttemptEvidence } from './loop-invocation-attempt';
import { isTerminalLoopRuntimeStatus } from './loop-runtime-status';

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

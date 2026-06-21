import { describe, it, expect, vi } from 'vitest';
import { createPendingToolResultsGate, registerBuiltinTerminationGates } from '../builtin-termination-gates';
import type { SessionState } from '../session-continuity';

function makeState(pendingTasks: SessionState['pendingTasks']): SessionState {
  return {
    instanceId: 'inst-1',
    displayName: 'Inst',
    agentId: 'build',
    modelId: 'claude',
    workingDirectory: '/tmp',
    conversationHistory: [],
    contextUsage: { used: 0, total: 100 },
    pendingTasks,
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
  } as unknown as SessionState;
}

describe('createPendingToolResultsGate', () => {
  it('passes when there are no in-flight tasks', async () => {
    const gate = createPendingToolResultsGate();
    const result = await gate.validate(makeState([]));
    expect(result.pass).toBe(true);
  });

  it('passes when the only pending tasks are non-in-flight (completion)', async () => {
    const gate = createPendingToolResultsGate();
    const result = await gate.validate(makeState([
      { id: 't1', type: 'completion', description: 'finish', createdAt: 1 },
    ]));
    expect(result.pass).toBe(true);
  });

  it('flags (pass:false) in-flight tool executions and unanswered approvals, with data', async () => {
    const gate = createPendingToolResultsGate();
    const result = await gate.validate(makeState([
      { id: 't1', type: 'tool_execution', description: 'run build', createdAt: 1 },
      { id: 't2', type: 'approval_required', description: 'approve rm', createdAt: 2 },
      { id: 't3', type: 'completion', description: 'ignored', createdAt: 3 },
    ]));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('2 in-flight task(s)');
    expect((result.data as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it('is bounded by a short timeout', () => {
    expect(createPendingToolResultsGate().timeoutMs).toBeLessThanOrEqual(2_000);
  });
});

describe('registerBuiltinTerminationGates', () => {
  it('registers the pending-tool-results gate on the continuity manager', () => {
    const registerTerminationGate = vi.fn();
    registerBuiltinTerminationGates({ registerTerminationGate } as never);
    expect(registerTerminationGate).toHaveBeenCalledTimes(1);
    expect(registerTerminationGate.mock.calls[0][0]).toMatchObject({ name: 'pending-tool-results' });
  });
});

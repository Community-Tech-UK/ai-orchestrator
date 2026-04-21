import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../session-continuity';
import { TerminationGateManager } from '../termination-gate-manager';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    instanceId: 'instance-1',
    sessionId: 'session-1',
    historyThreadId: 'thread-1',
    displayName: 'Terminating Session',
    agentId: 'build',
    modelId: 'claude-sonnet-4-6',
    provider: 'claude',
    workingDirectory: '/tmp/project',
    conversationHistory: [],
    contextUsage: {
      used: 10,
      total: 100,
    },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
    ...overrides,
  };
}

describe('TerminationGateManager', () => {
  it('emits blocked events for failing gates', async () => {
    const manager = new TerminationGateManager();
    const blocked = vi.fn();
    manager.on('gate:blocked', blocked);
    manager.registerGate({
      name: 'review',
      timeoutMs: 100,
      validate: vi.fn().mockResolvedValue({
        pass: false,
        reason: 'Review still running',
      }),
    });

    const results = await manager.runGates(makeState());

    expect(results).toEqual([
      {
        pass: false,
        reason: 'Review still running',
      },
    ]);
    expect(blocked).toHaveBeenCalledWith({
      gate: 'review',
      instanceId: 'instance-1',
      result: {
        pass: false,
        reason: 'Review still running',
      },
    });
  });

  it('fails open when a gate throws', async () => {
    const manager = new TerminationGateManager();
    manager.registerGate({
      name: 'unstable',
      validate: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const results = await manager.runGates(makeState());

    expect(results).toEqual([
      {
        pass: true,
        reason: "Gate 'unstable' error: boom",
      },
    ]);
  });
});

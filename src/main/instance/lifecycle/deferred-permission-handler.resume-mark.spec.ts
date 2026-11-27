import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import { DeferredPermissionHandler } from './deferred-permission-handler';
import { isResumingAfterDeferredPermission } from './deferred-permission-resume-registry';

vi.mock('./session-recovery', () => ({
  planSessionRecovery: () => ({ kind: 'native-resume' }),
  computeResumeConfigFingerprint: () => 'fingerprint',
}));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => undefined }));
vi.mock('./provider-session-durability', () => ({ applyProviderSessionDurability: (_cli: string, _instance: unknown, options: unknown) => options }));

function setup(options: { spawn: () => Promise<number> }) {
  const instance = {
    id: 'held', status: 'waiting_for_permission', provider: 'claude', currentModel: 'opus',
    executionLocation: { type: 'local' }, workingDirectory: '/workspace', yoloMode: false,
    outputBuffer: [], contextUsage: { used: 0, total: 1000, percentage: 0 },
  } as unknown as Instance;
  const oldAdapter = {
    getDeferredToolUse: () => ({ toolUseId: 'held-tool', toolName: 'mcp__orchestrator__account_trial', sessionId: 'native' }),
    getRuntimeCapabilities: () => ({ supportsResume: true }),
    getName: () => 'claude-cli',
    terminate: async () => undefined,
  };
  const seenDuringSpawn: boolean[] = [];
  const newAdapter = {
    config: { env: {} },
    spawn: async () => { seenDuringSpawn.push(isResumingAfterDeferredPermission('held')); return options.spawn(); },
  };
  const deps = {
    getInstance: () => instance, getAdapter: () => oldAdapter, setAdapter: vi.fn(), deleteAdapter: vi.fn(),
    setupAdapterEvents: vi.fn(), queueUpdate: vi.fn(),
  };
  const ops = {
    transitionState: (target: Instance, status: Instance['status']) => { target.status = status; },
    resolveCliTypeForInstance: async () => 'claude', getMcpConfig: () => [], getPermissionHookPath: () => undefined,
    waitForResumeHealth: async () => true, createCliAdapter: async () => newAdapter,
    acquireSessionMutex: async () => () => undefined,
  };
  const services = { writeDecision: vi.fn(), getDecisionDir: () => '/disposable-decisions', createDiffTracker: vi.fn() };
  // The test doubles cover only the members this path reads.
  const handler = new DeferredPermissionHandler(deps as never, ops as never, services as never);
  return { handler, instance, seenDuringSpawn };
}

describe('DeferredPermissionHandler resume mark', () => {
  it('marks the instance while the restarted process can replay the approved call, then clears it', async () => {
    const { handler, instance, seenDuringSpawn } = setup({ spawn: async () => 1234 });
    expect(isResumingAfterDeferredPermission('held')).toBe(false);
    await handler.resumeAfterDeferredPermission('held', true);
    expect(seenDuringSpawn).toEqual([true]);
    expect(instance.status).toBe('idle');
    expect(isResumingAfterDeferredPermission('held')).toBe(false);
  });

  it('clears the mark when the restart fails', async () => {
    const { handler, seenDuringSpawn } = setup({ spawn: async () => { throw new Error('spawn failed'); } });
    await expect(handler.resumeAfterDeferredPermission('held', true)).rejects.toThrow('spawn failed');
    expect(seenDuringSpawn).toEqual([true]);
    expect(isResumingAfterDeferredPermission('held')).toBe(false);
  });
});

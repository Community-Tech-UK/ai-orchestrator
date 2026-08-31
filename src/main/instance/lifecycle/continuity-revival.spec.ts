/**
 * Revival rebuilds a new instance from durable session state and keeps only the
 * newest slice of it, so it is another place the user's opening prompt can be
 * dropped for good. See prompt-retention.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConversationData } from '../../../shared/types/history.types';
import type { Instance, InstanceCreateConfig, OutputMessage } from '../../../shared/types/instance.types';
import type { ResolvedRecoveryCandidate } from '../../session/session-recovery-candidate-service';
import type { SessionState } from '../../session/session-continuity.types';
import { computeResumeConfigFingerprint } from './session-recovery';
import { reviveContinuitySession } from './continuity-revival';

const NOW = Date.UTC(2026, 7, 30, 12);

function history(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i === 0 ? 'user' : 'assistant',
    content: i === 0 ? 'Migrate the billing service.' : `turn ${i}`,
    timestamp: i + 1,
  }));
}

function makeDeps(entryCount: number) {
  const createInstance = vi.fn(async (config: InstanceCreateConfig) =>
    ({ id: 'revived-1', ...config }) as unknown as Instance);
  const deps = {
    resumeSession: vi.fn(async () => ({
      sessionId: 'sess-1',
      workingDirectory: '/repo',
      displayName: 'Revived',
      conversationHistory: history(entryCount),
    }) as unknown as SessionState),
    createInstance,
  };
  return { deps, createInstance };
}

function archivedConversation(messages: OutputMessage[]): ConversationData {
  return {
    entry: {
      id: 'history-entry-1',
      displayName: 'Recovered fixture',
      historyThreadId: 'history-thread-1',
      createdAt: NOW - 20_000,
      endedAt: NOW - 10_000,
      workingDirectory: '/repo',
      messageCount: messages.length,
      firstUserMessage: 'Opening fixture request',
      lastUserMessage: 'Opening fixture request',
      status: 'terminated',
      originalInstanceId: 'source-1',
      parentId: null,
      sessionId: 'archived-provider-session',
      provider: 'claude',
    },
    messages,
  };
}

function resolvedCandidate(
  overrides: {
    state?: Partial<SessionState>;
    historyMessages?: OutputMessage[];
  } = {},
): ResolvedRecoveryCandidate {
  const workingDirectory = '/repo';
  const provider = 'claude' as const;
  const state: SessionState = {
    instanceId: 'source-1',
    historyThreadId: 'history-thread-1',
    displayName: 'Recovered fixture',
    agentId: 'build',
    modelId: 'opus',
    provider,
    workingDirectory,
    conversationHistory: [
      {
        id: 'continuity-replay-user',
        role: 'user',
        content: 'Opening fixture request',
        timestamp: NOW - 8_000,
      },
      {
        id: 'continuity-suffix',
        role: 'assistant',
        content: 'Recovered suffix',
        timestamp: NOW - 2_000,
        toolUse: {
          toolName: 'FixtureTool',
          input: { value: 'placeholder' },
        },
      },
    ],
    contextUsage: { used: 12, total: 1_000 },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
    resumeCursor: {
      provider,
      threadId: 'native-thread-1',
      workspacePath: workingDirectory,
      capturedAt: NOW - 1_000,
      scanSource: 'native',
      configFingerprint: computeResumeConfigFingerprint({
        provider,
        model: 'opus',
        cwd: workingDirectory,
      }),
    },
    ...overrides.state,
  };
  const historyMessages = overrides.historyMessages ?? [
    {
      id: 'archived-user',
      type: 'user',
      content: 'Opening fixture request',
      timestamp: NOW - 8_500,
      metadata: { fixture: true },
    },
    {
      id: 'archived-assistant',
      type: 'assistant',
      content: 'Archived response',
      timestamp: NOW - 5_000,
    },
  ];
  return {
    candidate: {
      recoveryKey: 'history:claude:history-thread-1',
      sourceInstanceId: 'source-1',
      historyThreadId: 'history-thread-1',
      provider,
      modelId: 'opus',
      displayName: 'Recovered fixture',
      workingDirectory,
      lastActivityAt: NOW - 1_000,
      historyCoveredThrough: NOW - 5_000,
      recoveredMessageCount: 1,
      reason: 'newer-than-history',
      nativeResumeAvailable: true,
    },
    continuityState: state,
    historyConversation: archivedConversation(historyMessages),
  };
}

function makeCrashDeps(options: {
  readyPromise?: Promise<void>;
  replacementStatus?: Instance['status'];
} = {}) {
  const replacement = (config: InstanceCreateConfig) => ({
    id: 'replacement-1',
    status: options.replacementStatus ?? 'idle',
    readyPromise: options.readyPromise,
    ...config,
  }) as unknown as Instance;
  const createInstance = vi.fn(async (config: InstanceCreateConfig) => replacement(config));
  const publish = vi.fn();
  const rollback = vi.fn(async () => undefined);
  const createRecoveryInstance = vi.fn(async (config: InstanceCreateConfig) => ({
    instance: replacement(config),
    publish,
    rollback,
  }));
  return {
    deps: {
      resumeSession: vi.fn(),
      createInstance,
      createRecoveryInstance,
      queueContinuityPreamble: vi.fn(),
      now: () => NOW,
    },
    createInstance,
    createRecoveryInstance,
    publish,
    rollback,
  };
}

describe('reviveContinuitySession prompt retention', () => {
  it('carries an opening prompt that falls outside the restored window', async () => {
    const { deps, createInstance } = makeDeps(150);

    const result = await reviveContinuitySession(deps, {
      sourceInstanceId: 'src-1',
      initialPrompt: 'continue',
      reason: 'doc-review-submission',
    });

    const config = createInstance.mock.calls[0][0];
    // The opening prompt is genuinely outside the restored buffer...
    expect(config.initialOutputBuffer?.some((m) => m.content === 'Migrate the billing service.'))
      .toBe(false);
    // ...but survives on the retained set.
    expect(config.initialRetainedPrompts?.map((m) => m.content))
      .toEqual(['Migrate the billing service.']);
    expect(result).toEqual({ instanceId: 'revived-1', restoreMode: 'native' });
  });

  it('retains nothing when the whole history fits in the restored window', async () => {
    const { deps, createInstance } = makeDeps(10);

    await reviveContinuitySession(deps, {
      sourceInstanceId: 'src-1',
      initialPrompt: 'continue',
      reason: 'doc-review-submission',
    });

    const config = createInstance.mock.calls[0][0];
    expect(config.initialRetainedPrompts).toEqual([]);
    expect(config.initialOutputBuffer?.some((m) => m.content === 'Migrate the billing service.'))
      .toBe(true);
  });
});

describe('reviveContinuitySession crash recovery', () => {
  it('validates and starts a new native-resume instance with the lossless reconciled buffer', async () => {
    const resolved = resolvedCandidate();
    const original = structuredClone(resolved);
    const { deps, createRecoveryInstance, publish, rollback } = makeCrashDeps();

    const result = await reviveContinuitySession(deps, {
      sourceInstanceId: 'source-1',
      reason: 'crash-recovery',
      resolvedCandidate: resolved,
    });

    const config = createRecoveryInstance.mock.calls[0][0];
    expect(config).toMatchObject({
      historyThreadId: 'history-thread-1',
      sessionId: 'native-thread-1',
      resume: true,
      isRestoredSession: true,
    });
    expect(config.initialPrompt).toBeUndefined();
    expect(config.initialOutputBuffer?.map((message) => message.id)).toEqual([
      'archived-user',
      'archived-assistant',
      'continuity-suffix',
    ]);
    expect(config.initialOutputBuffer?.[0]?.metadata).toEqual({ fixture: true });
    expect(config.initialOutputBuffer?.[2]).toMatchObject({
      type: 'tool_use',
      metadata: {
        toolName: 'FixtureTool',
        input: { value: 'placeholder' },
      },
    });
    expect(deps.queueContinuityPreamble).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(result).toEqual({
      instanceId: 'replacement-1',
      restoreMode: 'native',
      recoveredMessageCount: 1,
    });
    expect(resolved).toEqual(original);
  });

  it.each([
    ['expired cursor', { resumeCursor: {
      provider: 'claude',
      threadId: 'native-thread-1',
      workspacePath: '/repo',
      capturedAt: NOW - (8 * 24 * 60 * 60 * 1_000),
      scanSource: 'native' as const,
    } }],
    ['previous native failure', { nativeResumeFailedAt: NOW - 500 }],
    ['legacy native failure marker', { nativeResumeFailedAt: 0 }],
    ['cursor config mismatch', { resumeCursor: {
      provider: 'claude',
      threadId: 'native-thread-1',
      workspacePath: '/repo',
      capturedAt: NOW - 1_000,
      scanSource: 'native' as const,
      configFingerprint: 'mismatched-placeholder',
    } }],
  ])('uses replay for %s and queues continuity only after readiness', async (_label, state) => {
    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const resolved = resolvedCandidate({ state });
    const { deps, createRecoveryInstance, publish } = makeCrashDeps({ readyPromise });

    const pending = reviveContinuitySession(deps, {
      sourceInstanceId: 'source-1',
      reason: 'crash-recovery',
      resolvedCandidate: resolved,
    });
    await vi.waitFor(() => expect(createRecoveryInstance).toHaveBeenCalledOnce());
    expect(deps.queueContinuityPreamble).not.toHaveBeenCalled();
    resolveReady?.();
    const result = await pending;

    const config = createRecoveryInstance.mock.calls[0][0];
    expect(config.sessionId).toBeUndefined();
    expect(config.resume).toBeUndefined();
    expect(deps.queueContinuityPreamble).toHaveBeenCalledWith(
      'replacement-1',
      expect.stringContaining('replay fallback (crash-recovery)'),
    );
    expect(result.restoreMode).toBe('replay');
    expect(publish).toHaveBeenCalledOnce();
  });

  it('rejects identity corruption before creating a replacement', async () => {
    const resolved = resolvedCandidate({ state: { instanceId: 'different-source' } });
    const original = structuredClone(resolved);
    const { deps, createRecoveryInstance } = makeCrashDeps();

    await expect(reviveContinuitySession(deps, {
      sourceInstanceId: 'source-1',
      reason: 'crash-recovery',
      resolvedCandidate: resolved,
    })).rejects.toThrow('Recovery candidate validation failed');

    expect(createRecoveryInstance).not.toHaveBeenCalled();
    expect(resolved).toEqual(original);
  });

  it('tears down only a partial replacement when startup fails', async () => {
    const startupFailure = new Error('fixture startup failure');
    const resolved = resolvedCandidate();
    const original = structuredClone(resolved);
    const { deps, rollback, publish } = makeCrashDeps({
      readyPromise: Promise.reject(startupFailure),
    });

    await expect(reviveContinuitySession(deps, {
      sourceInstanceId: 'source-1',
      reason: 'crash-recovery',
      resolvedCandidate: resolved,
    })).rejects.toThrow('Recovery replacement failed to start');

    expect(rollback).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledWith(startupFailure);
    expect(publish).not.toHaveBeenCalled();
    expect(resolved).toEqual(original);
  });

  it('rolls back a seeded replay replacement when continuity queuing fails', async () => {
    const resolved = resolvedCandidate({ state: { resumeCursor: null } });
    const original = structuredClone(resolved);
    const { deps, createRecoveryInstance, rollback, publish } = makeCrashDeps();
    const queueFailure = new Error('fixture replay queue failure');
    deps.queueContinuityPreamble.mockImplementation(() => {
      throw queueFailure;
    });

    await expect(reviveContinuitySession(deps, {
      sourceInstanceId: 'source-1',
      reason: 'crash-recovery',
      resolvedCandidate: resolved,
    })).rejects.toThrow('Recovery replacement failed to start');

    expect(createRecoveryInstance.mock.calls[0][0].initialOutputBuffer).toHaveLength(3);
    expect(rollback).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledWith(queueFailure);
    expect(publish).not.toHaveBeenCalled();
    expect(resolved).toEqual(original);
  });

  it('does not manufacture a history identity when the source has none', async () => {
    const resolved = resolvedCandidate({ state: {
      historyThreadId: undefined,
      sessionId: 'persisted-session-1',
      resumeCursor: null,
    } });
    resolved.candidate = {
      ...resolved.candidate,
      recoveryKey: 'session:claude:persisted-session-1',
      historyThreadId: undefined,
      nativeResumeAvailable: false,
    };
    resolved.historyConversation = null;
    const { deps, createRecoveryInstance } = makeCrashDeps();

    await reviveContinuitySession(deps, {
      sourceInstanceId: 'source-1',
      reason: 'crash-recovery',
      resolvedCandidate: resolved,
    });

    expect(createRecoveryInstance.mock.calls[0][0].historyThreadId).toBeUndefined();
  });

  it('restores a legacy role-tool record as a tool result', async () => {
    const resolved = resolvedCandidate({ state: {
      resumeCursor: null,
      conversationHistory: [{
        id: 'legacy-tool-result',
        role: 'tool',
        content: 'legacy fixture result',
        timestamp: NOW - 1_000,
      }],
    } });
    resolved.historyConversation = null;
    resolved.candidate.nativeResumeAvailable = false;
    const { deps, createRecoveryInstance } = makeCrashDeps();

    await reviveContinuitySession(deps, {
      sourceInstanceId: 'source-1',
      reason: 'crash-recovery',
      resolvedCandidate: resolved,
    });

    expect(createRecoveryInstance.mock.calls[0][0].initialOutputBuffer).toEqual([
      expect.objectContaining({
        id: 'legacy-tool-result', type: 'tool_result', content: 'legacy fixture result',
      }),
    ]);
  });
});

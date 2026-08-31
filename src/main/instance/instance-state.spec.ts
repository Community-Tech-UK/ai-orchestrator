import { describe, expect, it, vi } from 'vitest';
import type { ContextUsage, Instance, SessionDiffStats } from '../../shared/types/instance.types';
import { InstanceStateManager } from './instance-state';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Session',
    provider: 'claude',
    status: 'idle',
    ...overrides,
  } as unknown as Instance;
}

describe('InstanceStateManager', () => {
  it('keeps pending recovery instances and their updates out of public state', () => {
    vi.useFakeTimers();
    const state = new InstanceStateManager();
    const pending = makeInstance({
      sessionId: 'recovery-cursor-placeholder',
      metadata: { reason: 'crash-recovery', continuityRevival: true },
    });
    const batches: unknown[] = [];
    state.on('batch-update', (batch) => batches.push(batch));

    state.setPendingInstance(pending);
    state.queueUpdate(pending.id, 'busy');
    vi.advanceTimersByTime(1_000);

    expect(state.getInstance(pending.id)).toBeUndefined();
    expect(state.getAllInstances()).toEqual([]);
    expect(state.getInstanceCount()).toBe(0);
    expect(state.getRuntimeInstance(pending.id)).toBe(pending);
    expect(batches).toEqual([]);

    state.destroy();
    vi.useRealTimers();
  });

  it('publishes a pending instance before releasing its last buffered update', () => {
    vi.useFakeTimers();
    const state = new InstanceStateManager();
    const pending = makeInstance();
    const batches: Array<{ updates: Array<{ instanceId: string }> }> = [];
    state.on('batch-update', (batch) => batches.push(batch));
    state.setPendingInstance(pending);
    state.queueUpdate(pending.id, 'idle');

    state.publishPendingInstance(pending.id);
    expect(state.getInstance(pending.id)).toBe(pending);
    vi.advanceTimersByTime(1_000);
    expect(batches).toEqual([]);

    state.releasePendingUpdate(pending.id);
    vi.advanceTimersByTime(1_000);
    expect(batches.flatMap((batch) => batch.updates).map((update) => update.instanceId))
      .toEqual([pending.id]);

    state.destroy();
    vi.useRealTimers();
  });

  it('redacts crash-recovery session identity and internal metadata from IPC', () => {
    const state = new InstanceStateManager();
    const cursor = 'recovery-cursor-placeholder';
    const sourceInstanceId = 'source-instance-placeholder';
    const instance = makeInstance({
      sessionId: cursor,
      providerSessionId: cursor,
      historyThreadId: 'history-thread-placeholder',
      metadata: { reason: 'crash-recovery', continuityRevival: true, sourceInstanceId },
      communicationTokens: new Map(),
    });

    const serialized = state.serializeForIpc(instance);

    expect(JSON.stringify(serialized)).not.toContain(cursor);
    expect(JSON.stringify(serialized)).not.toContain(sourceInstanceId);
    expect(serialized['metadata']).toEqual({ reason: 'crash-recovery', continuityRevival: true });
    state.destroy();
  });

  it('redacts crash-recovery identities from batched renderer state updates', () => {
    vi.useFakeTimers();
    const state = new InstanceStateManager();
    const replacementAlias = 'recovery-batch-replacement-placeholder';
    const sourceAlias = 'recovery-batch-source-placeholder';
    const batches: Array<{ updates: Array<Record<string, unknown>> }> = [];
    state.on('batch-update', (batch) => batches.push(batch));
    state.setInstance(makeInstance({
      sessionId: replacementAlias,
      providerSessionId: replacementAlias,
      historyThreadId: sourceAlias,
      metadata: { reason: 'crash-recovery', continuityRevival: true },
    }));

    state.queueUpdate(
      'instance-1',
      'idle',
      undefined, undefined, undefined,
      {
        code: `RECOVERY_${sourceAlias}`,
        message: `fixture failure for ${replacementAlias}`,
        stack: `fixture stack for ${sourceAlias}`,
        timestamp: 1,
      },
      undefined,
      { providerSessionId: replacementAlias, historyThreadId: sourceAlias },
      undefined, undefined,
      { kind: 'resume-proof', provider: 'claude', sessionId: replacementAlias, startedAt: 1 },
    );
    vi.advanceTimersByTime(1_000);

    expect(JSON.stringify(batches)).not.toContain(replacementAlias);
    expect(JSON.stringify(batches)).not.toContain(sourceAlias);
    expect(batches[0]?.updates[0]?.['providerSessionId']).toBeUndefined();
    expect(batches[0]?.updates[0]?.['historyThreadId']).toBeUndefined();
    expect(batches[0]?.updates[0]?.['waitReason']).toEqual({
      kind: 'resume-proof', provider: 'claude',
      sessionId: '[recovery session omitted]', startedAt: 1,
    });
    state.destroy();
    vi.useRealTimers();
  });

  it('keeps ordinary-session ErrorInfo fields raw in batched renderer state updates', () => {
    vi.useFakeTimers();
    const state = new InstanceStateManager();
    const rawAlias = 'ordinary-error-code-alias-placeholder';
    const batches: Array<{ updates: Array<Record<string, unknown>> }> = [];
    state.on('batch-update', (batch) => batches.push(batch));
    state.setInstance(makeInstance({ metadata: { reason: 'ordinary-session' } }));

    state.queueUpdate(
      'instance-1', 'error', undefined, undefined, undefined,
      {
        code: `RAW_${rawAlias}`,
        message: `ordinary failure for ${rawAlias}`,
        stack: `ordinary stack for ${rawAlias}`,
        timestamp: 1,
      },
    );
    vi.advanceTimersByTime(1_000);

    expect(JSON.stringify(batches)).toContain(rawAlias);
    expect(batches[0]?.updates[0]?.['error']).toMatchObject({
      code: `RAW_${rawAlias}`,
      message: `ordinary failure for ${rawAlias}`,
    });
    state.destroy();
    vi.useRealTimers();
  });
  it('preserves queued context usage and diff stats when later updates omit them', () => {
    const state = new InstanceStateManager();
    const contextUsage: ContextUsage = {
      used: 100,
      total: 1000,
      percentage: 10,
    };
    const diffStats: SessionDiffStats = {
      totalAdded: 4,
      totalDeleted: 2,
      files: {
        'src/example.ts': {
          path: 'src/example.ts',
          status: 'modified',
          added: 4,
          deleted: 2,
        },
      },
    };

    state.queueUpdate('instance-1', 'busy', contextUsage, diffStats);
    state.queueUpdate('instance-1', 'idle');

    expect(
      (state as unknown as { pendingUpdates: Map<string, unknown> }).pendingUpdates.get('instance-1')
    ).toMatchObject({
      instanceId: 'instance-1',
      status: 'idle',
      contextUsage,
      diffStats,
    });

    state.destroy();
  });

  it('LT-160: writes waitReason directly onto the live instance, not only the pending broadcast', () => {
    const state = new InstanceStateManager();
    state.setInstance(makeInstance());

    state.queueUpdate(
      'instance-1',
      'idle',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { kind: 'quota-park', provider: 'claude', resumeAt: Date.now() + 60_000 },
    );

    // The synchronous, main-process source of truth (what SessionAdmissionService
    // and the mobile input queue read) must see the wait reason immediately —
    // not only the batched renderer-broadcast payload, which flushes later.
    expect(state.getInstance('instance-1')?.waitReason).toMatchObject({ kind: 'quota-park', provider: 'claude' });

    // `null` clears it on both the live object and the pending broadcast.
    state.queueUpdate('instance-1', 'idle', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
    expect(state.getInstance('instance-1')?.waitReason).toBeUndefined();

    state.destroy();
  });
});

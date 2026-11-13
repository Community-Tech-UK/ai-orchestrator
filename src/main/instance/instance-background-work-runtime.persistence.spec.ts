import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { SessionState } from '../session/session-continuity.types';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../session/safe-storage-accessor', () => ({ getSafeStorage: () => ({ isEncryptionAvailable: () => false }) }));
import * as continuity from '../session/session-continuity';
import { _resetSessionPersistenceQueueForTesting, getSessionPersistenceQueue } from '../session/session-persistence-queue';
import { _resetSessionMutexForTesting } from '../session/session-mutex';
import { outputMessageToContinuityEntry } from '../session/continuity-message-projection';
import { restoreWokenOutputBuffer } from './lifecycle/wake-buffer-restore';
import { bindBackgroundWorkTerminationReporter } from './instance-background-work-runtime';
import { _resetForTesting, getInstanceAsyncWorkRegistry } from './instance-async-work-registry';

const managers: continuity.SessionContinuityManager[] = [];
const notice: OutputMessage = {
  id: 'placeholder-background-stop', timestamp: 3, type: 'system',
  content: 'Closing this session also stopped 1 background command (sleep 300).',
  metadata: { backgroundCommandsStopped: 1 },
};
class Adapter extends EventEmitter {
  message: OutputMessage = notice;
  private reporter: ((message: OutputMessage) => void | Promise<void>) | null = null;
  setBackgroundWorkTerminationReporter(reporter: ((message: OutputMessage) => void | Promise<void>) | null): void {
    this.reporter = reporter;
  }
  async terminate(): Promise<void> { await this.reporter?.(this.message); }
}
async function createManager() {
  const manager = new continuity.SessionContinuityManager({ autoSaveEnabled: false });
  managers.push(manager);
  await manager.waitForRecoveryDiscoveryReady();
  return manager;
}
beforeEach(async () => { fixture.directory = await mkdtemp(join(tmpdir(), 'aio-background-stop-placeholder-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await getSessionPersistenceQueue().shutdown({ drain: true });
  managers.splice(0).forEach((manager) => manager.shutdown());
  await _resetSessionPersistenceQueueForTesting();
  _resetSessionMutexForTesting();
  _resetForTesting();
  await rm(fixture.directory, { recursive: true, force: true });
});

describe('hibernating background command shutdown persistence', () => {
  it.each([false, true])('survives saved-history wake and app restart, with ordinary output forwarding=%s', async (forwarded) => {
    const manager = await createManager();
    vi.spyOn(continuity, 'getSessionContinuityManagerIfInitialized').mockReturnValue(manager);
    const instance = {
      id: 'placeholder-codex-session', sessionId: 'placeholder-thread', provider: 'codex',
      displayName: 'Placeholder session', agentId: 'build', parentId: null,
      workingDirectory: fixture.directory, status: 'hibernating', lastActivity: 2,
      contextUsage: { used: 0, total: 1000, percentage: 0 },
      outputBuffer: [
        { id: 'placeholder-ask', timestamp: 1, type: 'user', content: 'Run the command.' },
        { id: 'placeholder-answer', timestamp: 2, type: 'assistant', content: 'The command is running.' },
      ],
    } as unknown as Instance;
    const adapter = new Adapter();
    let ordinaryForwarding: Promise<unknown> | undefined;
    bindBackgroundWorkTerminationReporter(instance.id, adapter as unknown as CliAdapter, {
      getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
    }, (message) => {
      instance.outputBuffer.push(message);
      if (forwarded) ordinaryForwarding = manager.addConversationEntry(instance.id, outputMessageToContinuityEntry(message));
    });
    // Hibernation saves first, then detaches listeners and kills the adapter.
    await manager.startTracking(instance);
    await manager.stopTracking(instance.id, true);
    adapter.removeAllListeners();
    await adapter.terminate();
    await ordinaryForwarding;
    const raw = JSON.parse(await readFile(join(manager.getRetentionContext().stateDir, `${instance.id}.json`), 'utf8')) as { data: string };
    const saved = JSON.parse(raw.data) as SessionState;
    expect(saved.conversationHistory.filter((entry) => entry.id === notice.id)).toHaveLength(1);
    restoreWokenOutputBuffer(instance, saved.conversationHistory, 1, 100);
    expect(instance.outputBuffer.at(-1)?.content).toBe(notice.content);
    const restarted = await createManager();
    const recovered = await restarted.loadRecoveryState(instance.id);
    expect(recovered?.conversationHistory.filter((entry) => entry.id === notice.id)).toHaveLength(1);
  });
});

function makeInstance(id: string, status: string): Instance {
  return {
    id, sessionId: 'placeholder-thread', provider: 'claude',
    displayName: 'Placeholder session', agentId: 'build', parentId: null,
    workingDirectory: fixture.directory, status, lastActivity: 2,
    contextUsage: { used: 0, total: 1000, percentage: 0 }, outputBuffer: [],
  } as unknown as Instance;
}
function stopMessage(stoppedHelpers: unknown[], id = 'placeholder-stopped-helpers-stop'): OutputMessage {
  return {
    id, timestamp: 4, type: 'system',
    content: 'Stopped 1 helper agent that had not finished.',
    metadata: { stoppedHelpers },
  };
}
const helperRecord = {
  toolUseId: 'toolu-1', agentId: 'agent-1', sessionId: 'session-old',
  transcriptPath: '/tmp/subagents/agent-a1.jsonl', toolUseCount: 3, lastActivityAt: 55,
};

describe('stopped helper resume capture', () => {
  it('persists stopped helper metadata before the registry clears, and survives restart', async () => {
    const manager = await createManager();
    vi.spyOn(continuity, 'getSessionContinuityManagerIfInitialized').mockReturnValue(manager);
    const persistSpy = vi.spyOn(manager, 'persistStoppedHelpers');
    const clearSpy = vi.spyOn(getInstanceAsyncWorkRegistry(), 'clearInstance');
    const instance = makeInstance('placeholder-claude-session', 'running');
    const adapter = new Adapter();
    adapter.message = stopMessage([helperRecord]);
    bindBackgroundWorkTerminationReporter(instance.id, adapter as unknown as CliAdapter, {
      getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
    }, () => {});
    await manager.startTracking(instance);
    await adapter.terminate();
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith(instance.id, [helperRecord]);
    expect(clearSpy).toHaveBeenCalledTimes(2);
    expect(persistSpy.mock.invocationCallOrder[0]!).toBeLessThan(clearSpy.mock.invocationCallOrder.at(-1)!);
    const restarted = await createManager();
    const recovered = await restarted.loadRecoveryState(instance.id);
    expect(recovered?.stoppedHelpers).toEqual([helperRecord]);
  });

  it('skips malformed stopped helper entries and never guesses their meaning', async () => {
    const manager = await createManager();
    vi.spyOn(continuity, 'getSessionContinuityManagerIfInitialized').mockReturnValue(manager);
    const instance = makeInstance('placeholder-claude-session', 'running');
    const adapter = new Adapter();
    adapter.message = stopMessage([
      helperRecord,
      { toolUseId: '', sessionId: 'session-old', lastActivityAt: 1 },
      'nonsense',
      { toolUseId: 'toolu-2', sessionId: 123, lastActivityAt: 2 },
      { toolUseId: 'toolu-3', sessionId: 'session-old', lastActivityAt: Number.NaN },
      { toolUseId: 'toolu-4' },
    ]);
    bindBackgroundWorkTerminationReporter(instance.id, adapter as unknown as CliAdapter, {
      getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
    }, () => {});
    await manager.startTracking(instance);
    await adapter.terminate();
    const restarted = await createManager();
    const recovered = await restarted.loadRecoveryState(instance.id);
    expect(recovered?.stoppedHelpers).toEqual([helperRecord]);
  });

  it('does not persist helpers for messages without stopped helper metadata', async () => {
    const manager = await createManager();
    vi.spyOn(continuity, 'getSessionContinuityManagerIfInitialized').mockReturnValue(manager);
    const persistSpy = vi.spyOn(manager, 'persistStoppedHelpers');
    const instance = makeInstance('placeholder-codex-session', 'running');
    const adapter = new Adapter();
    bindBackgroundWorkTerminationReporter(instance.id, adapter as unknown as CliAdapter, {
      getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
    }, () => {});
    await manager.startTracking(instance);
    await adapter.terminate();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('chains the hibernation notice after the stopped helper save, keeping one entry each', async () => {
    const manager = await createManager();
    vi.spyOn(continuity, 'getSessionContinuityManagerIfInitialized').mockReturnValue(manager);
    const instance = makeInstance('placeholder-claude-session', 'hibernating');
    const message = stopMessage([helperRecord]);
    const adapter = new Adapter();
    adapter.message = message;
    let ordinaryForwarding: Promise<unknown> | undefined;
    bindBackgroundWorkTerminationReporter(instance.id, adapter as unknown as CliAdapter, {
      getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
    }, (output) => {
      instance.outputBuffer.push(output);
      ordinaryForwarding = manager.addConversationEntry(instance.id, outputMessageToContinuityEntry(output));
    });
    await manager.startTracking(instance);
    await adapter.terminate();
    await ordinaryForwarding;
    const raw = JSON.parse(await readFile(join(manager.getRetentionContext().stateDir, `${instance.id}.json`), 'utf8')) as { data: string };
    const saved = JSON.parse(raw.data) as SessionState;
    expect(saved.conversationHistory.filter((entry) => entry.id === message.id)).toHaveLength(1);
    expect(saved.stoppedHelpers).toEqual([helperRecord]);
    const restarted = await createManager();
    const recovered = await restarted.loadRecoveryState(instance.id);
    expect(recovered?.conversationHistory.filter((entry) => entry.id === message.id)).toHaveLength(1);
    expect(recovered?.stoppedHelpers).toEqual([helperRecord]);
  });
});

describe('persistStoppedHelpers bookkeeping', () => {
  it('merges by tool-use id, keeping the newest record and sorting by last activity', async () => {
    const manager = await createManager();
    const instance = makeInstance('placeholder-claude-session', 'running');
    await manager.startTracking(instance);
    const first = { toolUseId: 'toolu-1', sessionId: 'session-old', lastActivityAt: 1, toolUseCount: 1 };
    const other = { toolUseId: 'toolu-2', sessionId: 'session-old', lastActivityAt: 2, toolUseCount: 7 };
    const newer = { toolUseId: 'toolu-1', agentId: 'agent-1', sessionId: 'session-old', lastActivityAt: 3, toolUseCount: 5 };
    await expect(manager.persistStoppedHelpers(instance.id, [first, other])).resolves.toBe(true);
    await expect(manager.persistStoppedHelpers(instance.id, [newer])).resolves.toBe(true);
    const restarted = await createManager();
    const recovered = await restarted.loadRecoveryState(instance.id);
    expect(recovered?.stoppedHelpers).toEqual([other, newer]);
  });

  it('keeps the 50 most recently active helpers', async () => {
    const manager = await createManager();
    const instance = makeInstance('placeholder-claude-session', 'running');
    await manager.startTracking(instance);
    const helpers = Array.from({ length: 60 }, (_, index) => ({
      toolUseId: `toolu-${index}`, sessionId: 'session-old', lastActivityAt: index,
    }));
    await expect(manager.persistStoppedHelpers(instance.id, helpers)).resolves.toBe(true);
    const restarted = await createManager();
    const recovered = await restarted.loadRecoveryState(instance.id);
    expect(recovered?.stoppedHelpers).toHaveLength(50);
    expect(recovered?.stoppedHelpers?.[0]).toEqual({ toolUseId: 'toolu-10', sessionId: 'session-old', lastActivityAt: 10 });
    expect(recovered?.stoppedHelpers?.at(-1)).toEqual({ toolUseId: 'toolu-59', sessionId: 'session-old', lastActivityAt: 59 });
  });

  it('reports failure for an instance that is not tracked', async () => {
    const manager = await createManager();
    await expect(manager.persistStoppedHelpers('placeholder-unknown-session', [helperRecord])).resolves.toBe(false);
  });
});

describe('takeStoppedHelpers one-shot delivery', () => {
  it('returns the stored helpers once, then nothing, and saves the clear', async () => {
    const manager = await createManager();
    const instance = makeInstance('placeholder-claude-session', 'running');
    await manager.startTracking(instance);
    await expect(manager.persistStoppedHelpers(instance.id, [helperRecord])).resolves.toBe(true);
    await expect(manager.takeStoppedHelpers(instance.id)).resolves.toEqual([helperRecord]);
    await expect(manager.takeStoppedHelpers(instance.id)).resolves.toBeNull();
    const restarted = await createManager();
    const recovered = await restarted.loadRecoveryState(instance.id);
    expect(recovered?.stoppedHelpers ?? []).toEqual([]);
  });

  it('returns null for an untracked instance and for one that never stored helpers', async () => {
    const manager = await createManager();
    await expect(manager.takeStoppedHelpers('placeholder-unknown-session')).resolves.toBeNull();
    const instance = makeInstance('placeholder-claude-session', 'running');
    await manager.startTracking(instance);
    await expect(manager.takeStoppedHelpers(instance.id)).resolves.toBeNull();
  });

  it('waits out an in-flight persist before taking, so a late merge cannot lose the notice', async () => {
    const manager = await createManager();
    const instance = makeInstance('placeholder-claude-session', 'running');
    await manager.startTracking(instance);
    let releaseStalledHydration!: () => void;
    const stalledHydration = new Promise<void>((done) => { releaseStalledHydration = done; });
    let notifyEntered!: () => void;
    const entered = new Promise<void>((done) => { notifyEntered = done; });
    const testable = manager as unknown as {
      hydrateTrackedState(instanceId: string, state: SessionState): Promise<SessionState>;
    };
    const hydrate = testable.hydrateTrackedState.bind(manager);
    let stalled = false;
    vi.spyOn(testable, 'hydrateTrackedState').mockImplementation(async (instanceId, state) => {
      const value = await hydrate(instanceId, state);
      if (!stalled) {
        stalled = true;
        notifyEntered();
        await stalledHydration;
      }
      return value;
    });
    const persisting = manager.persistStoppedHelpers(instance.id, [helperRecord]);
    await entered;
    const takenPromise = manager.takeStoppedHelpers(instance.id);
    releaseStalledHydration();
    await expect(persisting).resolves.toBe(true);
    await expect(takenPromise).resolves.toEqual([helperRecord]);
    await expect(manager.takeStoppedHelpers(instance.id)).resolves.toBeNull();
  });
});

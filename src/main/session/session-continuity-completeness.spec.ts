import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile } from '../../shared/types/agent.types';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';
import { createInstanceWithMessage } from '../ipc/handlers/instance-create-with-message';
import type { InstanceManager } from '../instance/instance-manager';
import { reviveContinuitySession } from '../instance/lifecycle/continuity-revival';
import type { SessionState } from './session-continuity.types';
import { writeContinuityPayloadAsyncAtomic } from './continuity-recovery-metadata';
import type { SessionContinuityPersistenceOperations } from './session-continuity-persistence-operations';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('./safe-storage-accessor', () => ({ getSafeStorage: () => ({ isEncryptionAvailable: () => false }) }));
import { SessionContinuityManager } from './session-continuity';
import { _resetSessionPersistenceQueueForTesting, getSessionPersistenceQueue } from './session-persistence-queue';
import { _resetSessionMutexForTesting } from './session-mutex';

const managers: SessionContinuityManager[] = [];
const agent = { id: 'build', mode: 'build' } as AgentProfile;
async function manager(operations: Partial<SessionContinuityPersistenceOperations> = {}) {
  const value = new SessionContinuityManager({ autoSaveEnabled: false, maxConversationEntries: 2 }, operations);
  managers.push(value);
  await value.waitForRecoveryDiscoveryReady();
  return value;
}
async function fresh(value: SessionContinuityManager, config: Partial<InstanceCreateConfig> = {}) {
  const instance = buildInstanceRecord({ workingDirectory: '/tmp/placeholder-project', provider: 'opencode', ...config }, agent, { defaultYoloMode: false, getParent: () => undefined });
  await value.startTracking(instance);
  return instance;
}
async function disk(value: SessionContinuityManager, id: string): Promise<SessionState> {
  const raw = JSON.parse(await readFile(join(value.getRetentionContext().stateDir, `${id}.json`), 'utf8')) as { data: string };
  return JSON.parse(raw.data) as SessionState;
}
const entry = (id: string) => ({ id, role: 'assistant' as const, content: `placeholder ${id}`, timestamp: Date.now() });

beforeEach(async () => { fixture.directory = await mkdtemp(join(tmpdir(), 'aio-continuity-complete-')); });
afterEach(async () => {
  await getSessionPersistenceQueue().shutdown({ drain: true });
  managers.splice(0).forEach((value) => value.shutdown());
  await _resetSessionPersistenceQueueForTesting();
  _resetSessionMutexForTesting();
  await rm(fixture.directory, { recursive: true, force: true });
});

describe('durable complete-conversation checkpoints', () => {
  it('retains complete fresh public current-submission capture through disk and native revival, but never unknown seeded records', async () => {
    const value = await manager(); let created!: Instance;
    const publicManager = { createInstance: async (config: InstanceCreateConfig) => {
      created = buildInstanceRecord(config, agent, { defaultYoloMode: false, getParent: () => undefined });
      await value.startTracking(created); return created;
    } } as InstanceManager;
    await createInstanceWithMessage(publicManager, { message: 'placeholder current request', provider: 'opencode', nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2 } }, '/tmp/placeholder-project', undefined);
    await value.prepareForProviderTurn(created.id);
    await value.addConversationEntry(created.id, entry('answer'));
    await value.checkpointCompleteConversation(created.id, value.captureConversationCheckpoint(created.id));
    const state = await disk(value, created.id);
    expect(state.conversationHistoryComplete).toBe(true);
    expect((state as SessionState & { nodePlacement?: unknown }).nodePlacement).toEqual({ requiresCli: 'opencode', requiresOpenCodeMajor: 2 });
    expect(state.conversationHistory.map((item) => item.content)).toEqual(['placeholder current request', 'placeholder answer']);
    state.resumeCursor = { provider: 'opencode', threadId: 'placeholder-native-thread', workspacePath: state.workingDirectory, capturedAt: Date.now() - 1, scanSource: 'native' };
    let revivedConfig!: InstanceCreateConfig;
    await reviveContinuitySession({
      resumeSession: async () => null, createInstance: async () => { throw new Error('unused'); },
      createRecoveryInstance: async (config) => {
        revivedConfig = config;
        return { instance: { id: 'placeholder-replacement', status: 'idle' } as Instance, publish: async () => undefined, rollback: async () => undefined };
      },
    }, { sourceInstanceId: state.instanceId, reason: 'crash-recovery', resolvedCandidate: {
      candidate: { recoveryKey: 'placeholder-key', sourceInstanceId: state.instanceId, provider: 'opencode', modelId: state.modelId, displayName: state.displayName, workingDirectory: state.workingDirectory, lastActivityAt: Date.now(), recoveredMessageCount: 2, reason: 'newer-than-history', nativeResumeAvailable: true },
      continuityState: state, historyConversation: null,
    } });
    expect(revivedConfig.metadata?.['transcriptKnown']).toBe(true);
    expect(revivedConfig.nodePlacement).toEqual({ requiresCli: 'opencode', requiresOpenCodeMajor: 2 });
    const unknown = await fresh(value, { initialPrompt: 'placeholder current request', initialOutputBuffer: [{ id: 'unknown', type: 'user', content: 'placeholder current request', timestamp: 1 }] });
    await value.prepareForProviderTurn(unknown.id);
    await value.checkpointCompleteConversation(unknown.id, value.captureConversationCheckpoint(unknown.id));
    expect((await disk(value, unknown.id)).conversationHistoryComplete).toBe(false);
  });

  it('writes an incomplete barrier before input, then saves a settled full short transcript, and invalidates the next turn on disk', async () => {
    const value = await manager(); const instance = await fresh(value);
    await value.prepareForProviderTurn(instance.id);
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
    await value.addConversationEntry(instance.id, entry('first'));
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    const saved = await disk(value, instance.id);
    expect(saved.conversationHistoryOriginKnown).toBe(true);
    expect(saved.conversationHistoryComplete).toBe(true);
    const restarted = await manager();
    expect((await restarted.loadRecoveryState(instance.id))?.conversationHistoryComplete).toBe(true);
    await value.prepareForProviderTurn(instance.id);
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
  });

  it('cannot promote a trimmed transcript again after its retained tail becomes short', async () => {
    const value = await manager(); const instance = await fresh(value);
    await value.prepareForProviderTurn(instance.id);
    for (const id of ['one', 'two', 'three']) await value.addConversationEntry(instance.id, entry(id));
    expect(value.getSessionState(instance.id)?.conversationHistory).toHaveLength(2);
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
    await value.updateState(instance.id, { conversationHistory: [entry('three')], conversationHistoryComplete: true, conversationHistoryOriginKnown: true });
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
  });

  it('invalidates capture loss before tracking starts and redaction after tracking', async () => {
    const value = await manager();
    const instance = buildInstanceRecord({ workingDirectory: '/tmp/placeholder-project', provider: 'opencode' }, agent, { defaultYoloMode: false, getParent: () => undefined });
    value.markConversationIncomplete(instance.id);
    await value.startTracking(instance);
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
    const other = await fresh(value); value.configure({ redactToolOutputs: true });
    await value.prepareForProviderTurn(other.id);
    expect(await value.addConversationEntry(other.id, { ...entry('tool'), role: 'tool' })).toBe(false);
    await value.checkpointCompleteConversation(other.id, value.captureConversationCheckpoint(other.id));
    expect((await disk(value, other.id)).conversationHistoryComplete).toBe(false);
  });

  it('does not promote imported or restored unknown records, or copy proof across an account switch', async () => {
    const value = await manager(); const restored = await fresh(value, { isRestoredSession: true });
    await value.checkpointCompleteConversation(restored.id, value.captureConversationCheckpoint(restored.id));
    expect((await disk(value, restored.id)).conversationHistoryComplete).toBe(false);
    const instance = await fresh(value);
    await value.addConversationEntry(instance.id, entry('one'));
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    const exported = await value.exportSession(instance.id); expect(exported?.state.conversationHistoryComplete).toBe(true);
    await value.importSession(exported!, 'imported-placeholder');
    expect((await disk(value, 'imported-placeholder')).conversationHistoryComplete).toBe(false);
    await value.updateState(instance.id, { accountProfileId: 'different-account' });
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
  });

  it('binds the first resolved account only at the explicit first-prompt barrier even if its user message was already captured', async () => {
    const value = await manager(); const instance = await fresh(value);
    await value.addConversationEntry(instance.id, { ...entry('submission'), role: 'user' });
    value.setInstanceManager({ getAdapter: () => undefined, getInstance: () => ({ status: 'idle', provider: 'opencode', accountProfileId: 'first-account' }) });
    await value.prepareForProviderTurn(instance.id);
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    const state = await disk(value, instance.id);
    expect(state.accountProfileId).toBe('first-account');
    expect(state.conversationHistoryComplete).toBe(true);
  });

  it('checks the live resolved account before a new prompt rather than copying completeness across account failover', async () => {
    const value = await manager(); const instance = await fresh(value, { accountProfileId: 'account-a' });
    await value.prepareForProviderTurn(instance.id);
    await value.addConversationEntry(instance.id, entry('one'));
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    value.setInstanceManager({ getAdapter: () => undefined, getInstance: () => ({ status: 'idle', provider: 'opencode', accountProfileId: 'account-b' }) });
    await value.prepareForProviderTurn(instance.id);
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    const state = await disk(value, instance.id);
    expect(state.accountProfileId).toBe('account-b');
    expect(state.conversationHistoryComplete).toBe(false);
  });

  it('invalidates named-account capture when the live route switches back to the default account', async () => {
    const value = await manager(); const instance = await fresh(value, { accountProfileId: 'account-a' });
    await value.prepareForProviderTurn(instance.id);
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    value.setInstanceManager({ getAdapter: () => undefined, getInstance: () => ({ status: 'idle', provider: 'opencode' }) });
    await value.prepareForProviderTurn(instance.id);
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    const state = await disk(value, instance.id);
    expect(state.accountProfileId).toBeUndefined();
    expect(state.conversationHistoryComplete).toBe(false);
  });

  it('refuses to advance the provider if the incomplete barrier cannot be saved', async () => {
    let fail = false;
    const value = await manager({ writePayloadAtomic: async (...args) => {
      if (fail) throw new Error('placeholder disk write failure');
      return writeContinuityPayloadAsyncAtomic(...args);
    } });
    const instance = await fresh(value);
    await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(true);
    fail = true;
    await expect(value.prepareForProviderTurn(instance.id)).rejects.toThrow('transcript');
    // The earlier checkpoint is still safe because no provider prompt may be sent.
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(true);
    expect(value.getSessionState(instance.id)?.conversationHistoryComplete).toBe(false);
  });

  it('fences an already-writing complete checkpoint when a new prompt invalidates its epoch', async () => {
    let block = false;
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const value = await manager({ writePayloadAtomic: async (...args) => {
      const raw = JSON.parse(args[1]) as { data: string };
      const state = JSON.parse(raw.data) as SessionState;
      if (block && state.conversationHistoryComplete === true) { started(); await gate; }
      return writeContinuityPayloadAsyncAtomic(...args);
    } });
    const instance = await fresh(value);
    await value.prepareForProviderTurn(instance.id);
    await value.addConversationEntry(instance.id, entry('one'));
    block = true;
    const oldCheckpoint = value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    await pending;
    await value.prepareForProviderTurn(instance.id);
    release(); await oldCheckpoint;
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
  });

  it('cancels an already-writing complete checkpoint when a concurrent queue drop loses capture coverage', async () => {
    let block = false; let release!: () => void; let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const value = await manager({ writePayloadAtomic: async (...args) => {
      const state = JSON.parse((JSON.parse(args[1]) as { data: string }).data) as SessionState;
      if (block && state.conversationHistoryComplete === true) { started(); await gate; }
      return writeContinuityPayloadAsyncAtomic(...args);
    } });
    const instance = await fresh(value); await value.prepareForProviderTurn(instance.id);
    await value.addConversationEntry(instance.id, entry('one')); block = true;
    const checkpoint = value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
    await pending; value.markConversationIncomplete(instance.id); release(); await checkpoint;
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
  });

  it('does not let an older queued checkpoint overwrite the next turn incomplete barrier', async () => {
    const value = await manager(); const instance = await fresh(value);
    const oldToken = value.captureConversationCheckpoint(instance.id);
    await value.prepareForProviderTurn(instance.id);
    await value.checkpointCompleteConversation(instance.id, oldToken);
    expect((await disk(value, instance.id)).conversationHistoryComplete).toBe(false);
  });
});

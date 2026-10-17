import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultAgent } from '../../shared/types/agent.types';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';
import { reviveContinuitySession } from '../instance/lifecycle/continuity-revival';
import type { SessionState } from './session-continuity.types';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('./safe-storage-accessor', () => ({ getSafeStorage: () => ({ isEncryptionAvailable: () => false }) }));
import { SessionContinuityManager } from './session-continuity';
import { SessionRecoveryCandidateService, type ResolvedRecoveryCandidate } from './session-recovery-candidate-service';
import { _resetSessionPersistenceQueueForTesting, getSessionPersistenceQueue } from './session-persistence-queue';
import { _resetSessionMutexForTesting } from './session-mutex';

const managers: SessionContinuityManager[] = [];
async function manager() {
  const value = new SessionContinuityManager({ autoSaveEnabled: false });
  managers.push(value);
  await value.waitForRecoveryDiscoveryReady();
  return value;
}
function candidates(value: SessionContinuityManager) {
  return new SessionRecoveryCandidateService({
    getSnapshot: () => null,
    waitForContinuityReady: () => value.waitForRecoveryDiscoveryReady(),
    listContinuityMetadata: (since, ids) => value.listContinuityRecoveryMetadata(since, ids),
    loadContinuityState: id => value.loadRecoveryState(id),
    waitForHistoryReady: async () => undefined,
    getHistoryCoverage: async () => new Map(), loadHistoryConversation: async () => null,
    isSuppressedByHistory: () => false, getLiveRecoveryKeys: () => new Set(), now: () => Date.now(),
  });
}
async function checkpoint(empty = false) {
  const value = await manager();
  const instance = buildInstanceRecord({ workingDirectory: fixture.directory, provider: 'opencode' }, getDefaultAgent(), {
    defaultYoloMode: false, getParent: () => undefined,
  });
  await value.startTracking(instance);
  if (!empty) {
    await value.prepareForProviderTurn(instance.id);
    await value.addConversationEntry(instance.id, { id: 'placeholder-user', role: 'user', content: 'Placeholder question', timestamp: Date.now() - 10 });
    await value.addConversationEntry(instance.id, { id: 'placeholder-answer', role: 'assistant', content: 'Placeholder answer', timestamp: Date.now() - 5 });
  }
  await value.checkpointCompleteConversation(instance.id, value.captureConversationCheckpoint(instance.id));
  await value.writeThroughIdentity(instance.id, { resumeCursor: { provider: 'opencode', threadId: instance.sessionId,
    workspacePath: fixture.directory, capturedAt: Date.now() - 1, scanSource: 'native' } });
  const file = join(value.getRetentionContext().stateDir, `${instance.id}.json`);
  const serialized = await readFile(file, 'utf8');
  const state = JSON.parse((JSON.parse(serialized) as { data: string }).data) as SessionState;
  expect(state.conversationHistoryComplete).toBe(true);
  return { instance, file, serialized, state };
}
function revival() {
  const createRecoveryInstance = vi.fn(async (_config: InstanceCreateConfig) => ({
    instance: { id: 'placeholder-replacement', status: 'idle' } as Instance,
    publish: async () => undefined, rollback: async () => undefined,
  }));
  const deps = { resumeSession: vi.fn(), createInstance: vi.fn(), createRecoveryInstance };
  return { createRecoveryInstance, revive: (resolved: ResolvedRecoveryCandidate) => reviveContinuitySession(deps, {
    sourceInstanceId: resolved.candidate.sourceInstanceId, reason: 'crash-recovery', resolvedCandidate: resolved,
  }) };
}
beforeEach(async () => { fixture.directory = await mkdtemp(join(tmpdir(), 'aio-hydration-placeholder-')); });
afterEach(async () => {
  await getSessionPersistenceQueue().shutdown({ drain: true });
  managers.splice(0).forEach(value => value.shutdown());
  await _resetSessionPersistenceQueueForTesting();
  _resetSessionMutexForTesting();
  await rm(fixture.directory, { recursive: true, force: true });
});

describe('continuity checkpoint hydration', () => {
  it.each(['missing', 'corrupt', 'unreadable'] as const)('refuses actual cached candidate recovery before creating an adapter when material becomes %s', async failure => {
    const saved = await checkpoint();
    const restarted = await manager();
    const service = candidates(restarted);
    const listed = await service.listCandidates();
    expect(listed).toHaveLength(1);
    expect(listed[0].recoveredMessageCount).toBe(2);
    await unlink(saved.file);
    if (failure === 'corrupt') await writeFile(saved.file, '{"encrypted":false,"data":"corrupt placeholder"}');
    if (failure === 'unreadable') await mkdir(saved.file);
    const { revive, createRecoveryInstance } = revival();
    await expect(service.resolveCandidate(listed[0].recoveryKey).then(revive)).rejects.toThrow('transcript is unavailable');
    expect(createRecoveryInstance).not.toHaveBeenCalled();
    // A second attempt must re-read material, rather than certify the empty dehydrated stub.
    await expect(restarted.loadRecoveryState(saved.instance.id)).rejects.toThrow('transcript is unavailable');
  });

  it('keeps successful durable proof available after failed hydration is retried', async () => {
    const saved = await checkpoint();
    const restarted = await manager();
    const service = candidates(restarted);
    const [listed] = await service.listCandidates();
    await unlink(saved.file);
    await expect(service.resolveCandidate(listed.recoveryKey)).rejects.toThrow('transcript is unavailable');
    await writeFile(saved.file, saved.serialized);
    const resolved = await service.resolveCandidate(listed.recoveryKey);
    expect(resolved.continuityState.conversationHistory).toEqual(saved.state.conversationHistory);
    expect(resolved.continuityState.conversationHistoryComplete).toBe(true);
    const { revive, createRecoveryInstance } = revival();
    await revive(resolved);
    expect(createRecoveryInstance.mock.calls[0][0]).toMatchObject({ resume: true, sessionId: saved.instance.sessionId,
      metadata: { transcriptKnown: true }, initialOutputBuffer: [expect.objectContaining({ id: 'placeholder-user' }), expect.objectContaining({ id: 'placeholder-answer' })] });
    await unlink(saved.file);
    // Once material is actually hydrated, loss of its file does not erase the retained in-memory transcript.
    expect((await restarted.loadRecoveryState(saved.instance.id))?.conversationHistoryComplete).toBe(true);
    expect((await restarted.loadRecoveryState(saved.instance.id))?.conversationHistory).toHaveLength(2);
  });

  it('never exposes a dehydrated stub as a complete checkpoint before loading its material', async () => {
    const saved = await checkpoint();
    const restarted = await manager();
    expect(restarted.getSessionState(saved.instance.id)?.conversationHistory).toEqual([]);
    expect(restarted.getSessionState(saved.instance.id)?.conversationHistoryComplete).toBe(false);
    expect((await restarted.loadRecoveryState(saved.instance.id))?.conversationHistoryComplete).toBe(true);
    expect((await readFile(saved.file, 'utf8'))).toBe(saved.serialized);
  });

  it('does not certify an empty restored buffer when cached candidate metadata proves messages existed', async () => {
    await checkpoint();
    const restarted = await manager();
    const service = candidates(restarted);
    const [listed] = await service.listCandidates();
    const resolved = await service.resolveCandidate(listed.recoveryKey);
    resolved.continuityState = { ...resolved.continuityState, conversationHistory: [] };
    const { revive, createRecoveryInstance } = revival();
    await revive(resolved);
    expect(createRecoveryInstance.mock.calls[0][0]).toMatchObject({ resume: true, metadata: { transcriptKnown: false } });
  });

  it('preserves a genuinely empty checkpoint after its complete disk material is successfully loaded', async () => {
    const saved = await checkpoint(true);
    const restarted = await manager();
    const state = await restarted.loadRecoveryState(saved.instance.id);
    expect(state?.conversationHistoryComplete).toBe(true);
    expect(state?.conversationHistory).toEqual([]);
    const { revive, createRecoveryInstance } = revival();
    await revive({ continuityState: state!, historyConversation: null, candidate: {
      recoveryKey: 'placeholder-empty', sourceInstanceId: saved.instance.id, provider: 'opencode',
      lastActivityAt: Date.now(), recoveredMessageCount: 0, reason: 'unarchived', nativeResumeAvailable: true,
    } });
    expect(createRecoveryInstance.mock.calls[0][0]).toMatchObject({ resume: true, metadata: { transcriptKnown: true }, initialOutputBuffer: [] });
  });
});

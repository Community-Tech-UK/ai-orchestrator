import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ConversationData } from '../../shared/types/history.types';
import type { SessionState } from './session-continuity.types';
import { LastStopSnapshotManager, type LastStopSnapshot } from './last-stop-snapshot';
import {
  MAX_SESSION_RECOVERY_CANDIDATES,
  RECOVERY_COVERAGE_SKEW_MS,
  RECOVERY_FALLBACK_WINDOW_MS,
  SessionRecoveryCandidateService,
  _resetSessionRecoveryCandidateServiceForTesting,
  getSessionRecoveryCandidateServiceIfInitialized,
  initializeSessionRecoveryCandidateService,
  getRecoveryIdentityKeys,
  wireSessionRecoveryCandidateInvalidation,
  type ContinuityRecoveryMetadata,
  type HistoryRecoveryCoverage,
  type SessionRecoveryCandidateDependencies,
} from './session-recovery-candidate-service';

const NOW = 2_000_000_000_000;
const tempDirs: string[] = [];

function metadata(
  id: string,
  overrides: Partial<ContinuityRecoveryMetadata> = {},
): ContinuityRecoveryMetadata {
  return {
    recoveryKey: `history:claude:thread-${id}`,
    sourceInstanceId: id,
    historyThreadId: `thread-${id}`,
    provider: 'claude',
    modelId: 'test-model',
    displayName: `Session ${id}`,
    workingDirectory: '/workspace/project',
    lastActivityAt: NOW - 1_000,
    modifiedAt: NOW - 500,
    messageCount: 2,
    hasUserPrompt: true,
    hasAssistantOutput: true,
    nativeResumeAvailable: true,
    ...overrides,
  };
}

function state(id: string): SessionState {
  return {
    instanceId: id,
    historyThreadId: `thread-${id}`,
    displayName: `Session ${id}`,
    agentId: 'general',
    modelId: 'test-model',
    provider: 'claude',
    workingDirectory: '/workspace/project',
    conversationHistory: [
      { id: `user-${id}`, role: 'user', content: 'fixture prompt', timestamp: NOW - 2_000 },
      { id: `assistant-${id}`, role: 'assistant', content: 'fixture response', timestamp: NOW - 1_000 },
    ],
    contextUsage: { used: 0, total: 1 },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
  };
}

function harness(options: {
  snapshot?: LastStopSnapshot | null;
  records?: ContinuityRecoveryMetadata[];
  coverage?: HistoryRecoveryCoverage[];
  liveKeys?: string[];
} = {}) {
  const records = options.records ?? [];
  const coverage = new Map(
    (options.coverage ?? []).map((item) => [item.recoveryKey, item]),
  );
  const loadContinuityState = vi.fn(async (id: string) => state(id));
  const loadHistoryConversation = vi.fn(async () => null as ConversationData | null);
  const deps: SessionRecoveryCandidateDependencies = {
    getSnapshot: () => options.snapshot ?? null,
    waitForContinuityReady: vi.fn(async () => undefined),
    listContinuityMetadata: vi.fn(async (modifiedSince: number) => {
      expect(modifiedSince).toBe(NOW - RECOVERY_FALLBACK_WINDOW_MS);
      return records;
    }),
    loadContinuityState,
    waitForHistoryReady: vi.fn(async () => undefined),
    getHistoryCoverage: vi.fn(async () => coverage),
    loadHistoryConversation,
    getLiveRecoveryKeys: () => new Set(options.liveKeys ?? []),
    now: () => NOW,
  };
  return {
    service: new SessionRecoveryCandidateService(deps),
    deps,
    loadContinuityState,
    loadHistoryConversation,
  };
}

describe('SessionRecoveryCandidateService', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classifies continuity beyond history coverage plus skew as newer-than-history', async () => {
    const record = metadata('newer');
    const { service } = harness({
      records: [record],
      coverage: [{
        recoveryKey: record.recoveryKey,
        historyEntryId: 'history-newer',
        coveredThrough: record.lastActivityAt - RECOVERY_COVERAGE_SKEW_MS - 1,
        messageCount: 1,
      }],
    });

    await expect(service.listCandidates()).resolves.toEqual([
      expect.objectContaining({
        sourceInstanceId: 'newer',
        reason: 'newer-than-history',
        recoveredMessageCount: 1,
      }),
    ]);
  });

  it('ignores malformed optional identity runtime types without throwing', () => {
    const malformed = {
      provider: 'claude',
      recoveryKey: 42,
      historyThreadId: false,
      sessionId: { invalid: true },
      sourceInstanceId: ['invalid'],
    } as unknown as Parameters<typeof getRecoveryIdentityKeys>[0];

    expect(() => getRecoveryIdentityKeys(malformed)).not.toThrow();
    expect(getRecoveryIdentityKeys(malformed)).toEqual([]);
  });

  it('classifies meaningful continuity with no history as unarchived', async () => {
    const { service } = harness({ records: [metadata('unarchived')] });
    await expect(service.listCandidates()).resolves.toEqual([
      expect.objectContaining({ reason: 'unarchived', recoveredMessageCount: 2 }),
    ]);
  });

  it('classifies a user-only continuity record with no history as draft-only', async () => {
    const { service } = harness({
      records: [metadata('draft', { messageCount: 1, hasAssistantOutput: false })],
    });
    await expect(service.listCandidates()).resolves.toEqual([
      expect.objectContaining({ reason: 'draft-only', recoveredMessageCount: 1 }),
    ]);
  });

  it('excludes empty, fully covered, jitter-only, and currently live logical threads', async () => {
    const covered = metadata('covered');
    const jitter = metadata('jitter');
    const live = metadata('live');
    const { service } = harness({
      records: [
        metadata('empty', { messageCount: 0, hasUserPrompt: false, hasAssistantOutput: false }),
        covered,
        jitter,
        live,
      ],
      coverage: [
        {
          recoveryKey: covered.recoveryKey,
          historyEntryId: 'history-covered',
          coveredThrough: covered.lastActivityAt,
          messageCount: covered.messageCount,
        },
        {
          recoveryKey: jitter.recoveryKey,
          historyEntryId: 'history-jitter',
          coveredThrough: jitter.lastActivityAt - RECOVERY_COVERAGE_SKEW_MS,
          messageCount: jitter.messageCount,
        },
      ],
      liveKeys: [live.recoveryKey],
    });

    await expect(service.listCandidates()).resolves.toEqual([]);
  });

  it.each(['v1', 'missing', 'corrupt'] as const)(
    'falls back to recent continuity metadata through a real $case snapshot read',
    async (snapshotCase) => {
      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-snapshot-'));
      tempDirs.push(storeDir);
      if (snapshotCase === 'v1') {
        fs.writeFileSync(path.join(storeDir, 'last-stop.json'), JSON.stringify({
          version: 1,
          writtenAt: NOW - 100,
          sessions: [{
            instanceId: 'legacy-hint', sessionId: 'legacy-provider-placeholder',
            provider: 'claude', displayName: 'Legacy hint',
            workingDirectory: '/workspace/project', capturedAt: NOW - 100,
          }],
        }));
      } else if (snapshotCase === 'corrupt') {
        fs.writeFileSync(path.join(storeDir, 'last-stop.json'), '{invalid-json');
      }
      const snapshot = new LastStopSnapshotManager(storeDir).getSnapshot();
      expect(snapshotCase === 'v1' ? snapshot?.version : snapshot).toBe(snapshotCase === 'v1' ? 2 : null);
      const { service } = harness({ snapshot, records: [metadata('fallback')] });
      await expect(service.listCandidates()).resolves.toHaveLength(1);
    },
  );

  it('isolates an omitted corrupt record and still returns valid metadata records', async () => {
    const { service } = harness({ records: [metadata('valid-after-corrupt')] });
    await expect(service.listCandidates()).resolves.toEqual([
      expect.objectContaining({ sourceInstanceId: 'valid-after-corrupt' }),
    ]);
  });

  it('orders deterministically and caps results after preserving v2 shutdown-live entries', async () => {
    const records = Array.from({ length: 80 }, (_, index) => metadata(
      `candidate-${String(index).padStart(3, '0')}`,
      { lastActivityAt: NOW - index },
    ));
    const shutdownLive = metadata('shutdown-live', {
      lastActivityAt: NOW - 10_000,
      modifiedAt: NOW - 10_000,
    });
    const snapshot: LastStopSnapshot = {
      version: 2,
      writtenAt: NOW - 100,
      sessions: [{
        instanceId: shutdownLive.sourceInstanceId,
        historyThreadId: shutdownLive.historyThreadId,
        provider: shutdownLive.provider,
        modelId: shutdownLive.modelId,
        displayName: shutdownLive.displayName ?? '',
        workingDirectory: shutdownLive.workingDirectory ?? '',
        capturedAt: NOW - 100,
        recoveryKey: shutdownLive.recoveryKey,
        lastActivityAt: shutdownLive.lastActivityAt,
        isLive: true,
        messageCount: shutdownLive.messageCount,
        hasAssistantOutput: shutdownLive.hasAssistantOutput,
      }],
    };
    const { service } = harness({ snapshot, records });

    const candidates = await service.listCandidates();
    expect(candidates).toHaveLength(MAX_SESSION_RECOVERY_CANDIDATES + 1);
    expect(candidates.map((item) => item.sourceInstanceId)).toContain('shutdown-live');
    expect(candidates[0]?.sourceInstanceId).toBe('candidate-000');
    expect(candidates.at(-1)?.sourceInstanceId).toBe('shutdown-live');
  });

  it('does not hydrate full state while listing thousands of metadata stubs', async () => {
    const records = Array.from({ length: 3_000 }, (_, index) => metadata(
      `stub-${String(index).padStart(4, '0')}`,
      { lastActivityAt: NOW - index },
    ));
    const { service, deps, loadContinuityState } = harness({ records });

    const candidates = await service.listCandidates();

    expect(candidates).toHaveLength(MAX_SESSION_RECOVERY_CANDIDATES);
    expect(loadContinuityState).not.toHaveBeenCalled();
    expect(deps.getHistoryCoverage).toHaveBeenCalledWith(expect.any(Array));
    expect((deps.getHistoryCoverage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
      .toHaveLength(MAX_SESSION_RECOVERY_CANDIDATES);
  });

  it('applies cheap exclusions before requesting bounded history coverage', async () => {
    const live = metadata('live-cheap');
    const { service, deps } = harness({
      records: [
        metadata('empty-cheap', { messageCount: 0, hasUserPrompt: false, hasAssistantOutput: false }),
        metadata('stateless-cheap', { provider: 'gemini' }),
        live,
        metadata('eligible-cheap'),
      ],
      liveKeys: [live.recoveryKey],
    });
    await service.listCandidates();
    const identities = (deps.getHistoryCoverage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(identities).toEqual([expect.objectContaining({ recoveryKey: 'history:claude:thread-eligible-cheap' })]);
  });

  it('deduplicates canonical keys and orders tied activity by key then instance id', async () => {
    const { service } = harness({ records: [
      metadata('older-generation', { recoveryKey: 'history:claude:shared', lastActivityAt: NOW - 5 }),
      metadata('newer-generation', { recoveryKey: 'history:claude:shared', lastActivityAt: NOW }),
      metadata('zeta', { recoveryKey: 'history:claude:zeta', lastActivityAt: NOW }),
      metadata('alpha', { recoveryKey: 'history:claude:alpha', lastActivityAt: NOW }),
    ] });
    const candidates = await service.listCandidates();
    expect(candidates.map((item) => item.sourceInstanceId)).toEqual([
      'alpha', 'newer-generation', 'zeta',
    ]);
  });

  it('awaits history readiness before coverage and caches only the ready result', async () => {
    const record = metadata('readiness');
    const { service, deps } = harness({ records: [record] });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    deps.waitForHistoryReady = vi.fn(() => ready);
    const pending = service.listCandidates();
    await Promise.resolve();
    expect(deps.getHistoryCoverage).not.toHaveBeenCalled();
    release();
    await pending;
    expect(deps.waitForHistoryReady).toHaveBeenCalledOnce();
    expect(deps.getHistoryCoverage).toHaveBeenCalledOnce();
    await service.listCandidates();
    expect(deps.getHistoryCoverage).toHaveBeenCalledOnce();
  });

  it('does not scan or cache candidates before actual continuity initialization completes', async () => {
    const record = metadata('continuity-readiness');
    const { service, deps } = harness({ records: [record] });
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    deps.waitForContinuityReady = vi.fn(() => ready);
    let settled = false;

    const pending = service.listCandidates().then((candidates) => {
      settled = true;
      return candidates;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(deps.listContinuityMetadata).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual([
      expect.objectContaining({ sourceInstanceId: 'continuity-readiness' }),
    ]);
    await service.listCandidates();
    expect(deps.waitForContinuityReady).toHaveBeenCalledOnce();
    expect(deps.listContinuityMetadata).toHaveBeenCalledOnce();
  });

  it('hydrates only the explicitly resolved candidate and never starts a process', async () => {
    const record = metadata('resolve');
    const { service, loadContinuityState, loadHistoryConversation } = harness({ records: [record] });

    const resolved = await service.resolveCandidate(record.recoveryKey);

    expect(resolved.candidate.sourceInstanceId).toBe('resolve');
    expect(resolved.continuityState.instanceId).toBe('resolve');
    expect(loadContinuityState).toHaveBeenCalledTimes(1);
    expect(loadHistoryConversation).not.toHaveBeenCalled();
  });

  it('invalidates cached metadata after lifecycle changes', async () => {
    const record = metadata('cached');
    const { service, deps } = harness({ records: [record] });

    await service.listCandidates();
    await service.listCandidates();
    expect(deps.listContinuityMetadata).toHaveBeenCalledTimes(1);

    service.invalidate();
    await service.listCandidates();
    expect(deps.listContinuityMetadata).toHaveBeenCalledTimes(2);
  });

  it('does not let an invalidated in-flight scan repopulate the cache after live-key capture', async () => {
    const record = metadata('became-live-during-scan');
    const { service, deps } = harness({ records: [record] });
    let live = false;
    let releaseCoverage!: () => void;
    const coverageBarrier = new Promise<void>((resolve) => { releaseCoverage = resolve; });
    deps.getLiveRecoveryKeys = vi.fn(() => new Set(live ? [record.recoveryKey] : []));
    deps.getHistoryCoverage = vi.fn()
      .mockImplementationOnce(async () => {
        await coverageBarrier;
        return new Map<string, HistoryRecoveryCoverage>();
      })
      .mockResolvedValue(new Map<string, HistoryRecoveryCoverage>());

    const pending = service.listCandidates();
    await vi.waitFor(() => {
      expect(deps.getHistoryCoverage).toHaveBeenCalledOnce();
    });
    live = true;
    service.invalidate();
    releaseCoverage();

    await expect(pending).resolves.toEqual([]);
    expect(deps.listContinuityMetadata).toHaveBeenCalledTimes(2);
    expect(deps.getLiveRecoveryKeys).toHaveBeenCalledTimes(2);
    await expect(service.listCandidates()).resolves.toEqual([]);
    expect(deps.listContinuityMetadata).toHaveBeenCalledTimes(2);
  });

  it('exposes an explicit composition-root singleton and reset boundary', () => {
    _resetSessionRecoveryCandidateServiceForTesting();
    const { deps } = harness();
    const initialized = initializeSessionRecoveryCandidateService(deps);

    expect(getSessionRecoveryCandidateServiceIfInitialized()).toBe(initialized);

    _resetSessionRecoveryCandidateServiceForTesting();
    expect(getSessionRecoveryCandidateServiceIfInitialized()).toBeNull();
  });

  it('invalidates through existing instance creation and termination events', () => {
    const { service } = harness();
    const invalidate = vi.spyOn(service, 'invalidate');
    const lifecycle = new EventEmitter();
    const dispose = wireSessionRecoveryCandidateInvalidation(service, lifecycle);

    lifecycle.emit('instance:created', { id: 'created-instance' });
    lifecycle.emit('instance:removed', 'terminated-instance');
    expect(invalidate).toHaveBeenCalledTimes(2);

    dispose();
    lifecycle.emit('instance:created', { id: 'later-instance' });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});

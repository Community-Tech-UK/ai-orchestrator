import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceCreateConfig, OutputMessage } from '../../shared/types/instance.types';
import type { SessionState } from './session-continuity.types';

const fixtureRuntime = vi.hoisted(() => ({ userDataRoot: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name !== 'userData') throw new Error(`Unexpected path lookup: ${name}`);
      return fixtureRuntime.userDataRoot;
    }),
  },
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => true }),
}));

import { HistoryManager } from '../history/history-manager';
import { ContinuityRecoveryCoordinator } from '../instance/lifecycle/continuity-recovery-coordinator';
import { reviveContinuitySession } from '../instance/lifecycle/continuity-revival';
import { createHarnessShutdownOperations } from '../process/harness-shutdown-operations';
import {
  GracefulShutdownManager,
  startGracefulQuitFlow,
} from '../process/graceful-shutdown';
import {
  LastStopSnapshotManager,
  _resetLastStopSnapshotForTesting,
  initLastStopSnapshot,
} from './last-stop-snapshot';
import {
  SessionRecoveryCandidateService,
  _resetSessionRecoveryCandidateServiceForTesting,
  initializeSessionRecoveryCandidateService,
} from './session-recovery-candidate-service';
import {
  SessionContinuityManager,
  getSessionContinuityManagerIfInitialized,
} from './session-continuity';
import { _resetSessionPersistenceQueueForTesting } from './session-persistence-queue';

const BASE_TIME = Date.UTC(2026, 7, 30, 12);
const HISTORY_THREAD_ID = 'fixture-history-thread';
const PROVIDER_SESSION_ID = 'fixture-provider-session';
const SOURCE_INSTANCE_ID = 'fixture-source-runtime';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function output(
  id: string,
  type: OutputMessage['type'],
  content: string,
  timestamp: number,
): OutputMessage {
  return { id, type, content, timestamp };
}

function instance(overrides: Partial<Instance> = {}): Instance {
  const messages = overrides.outputBuffer ?? [];
  return {
    id: SOURCE_INSTANCE_ID,
    displayName: 'Fixture recovery session',
    createdAt: BASE_TIME - 40_000,
    historyThreadId: HISTORY_THREAD_ID,
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    depth: 0,
    terminationPolicy: 'terminate-children',
    launchMode: 'orchestrated',
    executionLocation: { type: 'local' },
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: { enabled: false, state: 'off' },
    status: 'busy',
    contextUsage: { used: 0, total: 1_000, percentage: 0 },
    lastActivity: messages.at(-1)?.timestamp ?? BASE_TIME,
    processId: null,
    providerSessionId: PROVIDER_SESSION_ID,
    sessionId: PROVIDER_SESSION_ID,
    restartEpoch: 0,
    workingDirectory: path.join(fixtureRuntime.userDataRoot, 'fixture-workspace'),
    yoloMode: false,
    provider: 'claude',
    currentModel: 'fixture-model',
    outputBuffer: messages,
    retainedPrompts: [],
    outputBufferMaxSize: 1_000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    ...overrides,
  };
}

function state(instanceId: string, timestamp: number): SessionState {
  return {
    instanceId,
    historyThreadId: `${HISTORY_THREAD_ID}-${instanceId}`,
    sessionId: `${PROVIDER_SESSION_ID}-${instanceId}`,
    displayName: `Fixture ${instanceId}`,
    agentId: 'build',
    modelId: 'fixture-model',
    provider: 'claude',
    workingDirectory: path.join(fixtureRuntime.userDataRoot, 'fixture-workspace'),
    conversationHistory: [
      { id: `${instanceId}-user`, role: 'user', content: 'Fixture prompt', timestamp },
      {
        id: `${instanceId}-assistant`, role: 'assistant',
        content: 'Fixture response', timestamp: timestamp + 1,
      },
    ],
    contextUsage: { used: 0, total: 1_000 },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
  };
}

async function readBytes(files: readonly string[]): Promise<Map<string, Buffer>> {
  return new Map(await Promise.all(files.map(async (file) => (
    [file, await fs.promises.readFile(file)] as const
  ))));
}

async function expectBytes(files: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [file, expected] of files) {
    await expect(fs.promises.readFile(file)).resolves.toEqual(expected);
  }
}

function candidateService(
  continuity: SessionContinuityManager,
  history: HistoryManager,
  lastStop: LastStopSnapshotManager,
  liveKeys: () => ReadonlySet<string>,
): SessionRecoveryCandidateService {
  return new SessionRecoveryCandidateService({
    getSnapshot: () => lastStop.getSnapshot(),
    waitForContinuityReady: () => continuity.waitForRecoveryDiscoveryReady(),
    listContinuityMetadata: (modifiedSince, preferredInstanceIds) =>
      continuity.listContinuityRecoveryMetadata(modifiedSince, preferredInstanceIds),
    loadContinuityState: (sourceInstanceId) => continuity.loadRecoveryState(sourceInstanceId),
    waitForHistoryReady: () => history.startupTasks,
    getHistoryCoverage: (identities) => history.getRecoveryCoverage(identities),
    loadHistoryConversation: (entryId) => history.loadConversation(entryId),
    getLiveRecoveryKeys: liveKeys,
    now: () => BASE_TIME,
  });
}

describe('abrupt restart recovery integration', () => {
  const tempRoots: string[] = [];
  const managers: SessionContinuityManager[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    fixtureRuntime.userDataRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'session-restart-recovery-'),
    );
    tempRoots.push(fixtureRuntime.userDataRoot);
    _resetLastStopSnapshotForTesting();
    _resetSessionRecoveryCandidateServiceForTesting();
    _resetSessionPersistenceQueueForTesting();
    GracefulShutdownManager._resetForTesting();
  });

  afterEach(async () => {
    _resetLastStopSnapshotForTesting();
    _resetSessionRecoveryCandidateServiceForTesting();
    GracefulShutdownManager._resetForTesting();
    for (const manager of managers.splice(0)) manager.shutdown();
    vi.useRealTimers();
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    getSessionContinuityManagerIfInitialized()?.shutdown();
    _resetSessionPersistenceQueueForTesting();
  });

  it.each(['v1', 'missing'] as const)(
    'discovers recent continuity through the real %s snapshot fallback',
    async (snapshotCase) => {
      const source = new SessionContinuityManager({ autoSaveEnabled: false });
      managers.push(source);
      await source.waitForRecoveryDiscoveryReady();
      const persisted = state(`fallback-${snapshotCase}`, BASE_TIME - 2_000);
      await source.importSession({ state: persisted });
      source.shutdown();

      const snapshotDir = path.join(fixtureRuntime.userDataRoot, 'session-continuity');
      if (snapshotCase === 'v1') {
        await fs.promises.writeFile(path.join(snapshotDir, 'last-stop.json'), JSON.stringify({
          version: 1,
          writtenAt: BASE_TIME,
          sessions: [{
            instanceId: persisted.instanceId,
            historyThreadId: persisted.historyThreadId,
            sessionId: persisted.sessionId,
            provider: persisted.provider,
            displayName: persisted.displayName,
            workingDirectory: persisted.workingDirectory,
            capturedAt: BASE_TIME - 3_000,
          }],
        }));
      }

      const restartedContinuity = new SessionContinuityManager({ autoSaveEnabled: false });
      const restartedHistory = new HistoryManager();
      managers.push(restartedContinuity);
      const recovery = candidateService(
        restartedContinuity,
        restartedHistory,
        new LastStopSnapshotManager(snapshotDir),
        () => new Set(),
      );

      const candidates = await recovery.listCandidates();
      expect(candidates).toEqual([
        expect.objectContaining({
          sourceInstanceId: persisted.instanceId,
          reason: 'unarchived',
          recoveredMessageCount: 2,
        }),
      ]);
      const resolved = await recovery.resolveCandidate(candidates[0].recoveryKey);
      let recoveryConfig: InstanceCreateConfig | undefined;
      const restored = await reviveContinuitySession({
        resumeSession: async () => null,
        createInstance: async (config) => instance(config as Partial<Instance>),
        createRecoveryInstance: async (config) => {
          recoveryConfig = config;
          return {
            instance: instance({
              ...config,
              id: `replacement-${snapshotCase}`,
              status: 'idle',
              outputBuffer: config.initialOutputBuffer ?? [],
            } as Partial<Instance>),
            publish: async () => undefined,
            rollback: async () => undefined,
          };
        },
        queueContinuityPreamble: () => undefined,
        now: () => BASE_TIME,
      }, {
        sourceInstanceId: persisted.instanceId,
        reason: 'crash-recovery',
        resolvedCandidate: resolved,
      });
      expect(restored).toMatchObject({
        instanceId: `replacement-${snapshotCase}`,
        recoveredMessageCount: 2,
        restoreMode: 'replay',
      });
      expect(recoveryConfig?.initialOutputBuffer?.map((message) => message.id)).toEqual([
        `${persisted.instanceId}-user`,
        `${persisted.instanceId}-assistant`,
      ]);
    },
  );

  it('restores the exact missing suffix after the synchronous boundary and an interrupted archive', async () => {
    const archivedMessages = [
      output('archive-user', 'user', 'Fixture opening request', BASE_TIME - 30_000),
      output('archive-assistant', 'assistant', 'Fixture archived response', BASE_TIME - 25_000),
    ];
    vi.setSystemTime(BASE_TIME - 20_000);
    const historyBeforeRestart = new HistoryManager();
    await historyBeforeRestart.startupTasks;
    await historyBeforeRestart.archiveInstance(instance({
      id: 'fixture-archived-runtime',
      status: 'terminated',
      outputBuffer: archivedMessages,
      lastActivity: archivedMessages.at(-1)?.timestamp ?? 0,
    }));

    vi.setSystemTime(BASE_TIME);
    const continuityBeforeRestart = new SessionContinuityManager({ autoSaveEnabled: false });
    managers.push(continuityBeforeRestart);
    await continuityBeforeRestart.waitForRecoveryDiscoveryReady();
    const continuityMessages = [
      output('replay-user', 'user', 'Fixture opening request', BASE_TIME - 30_000),
      output('replay-assistant', 'assistant', 'Fixture archived response', BASE_TIME - 25_000),
      output('suffix-later', 'assistant', 'Fixture recovered suffix two', BASE_TIME - 3_000),
      output('suffix-earlier', 'user', 'Fixture recovered suffix one', BASE_TIME - 4_000),
    ];
    const sourceInstance = instance({ outputBuffer: continuityMessages });
    await continuityBeforeRestart.startTracking(sourceInstance);
    continuityBeforeRestart.setInstanceManager({
      getAdapter: () => undefined,
      getInstance: () => ({ status: 'busy' }),
    });
    const snapshotDir = path.join(fixtureRuntime.userDataRoot, 'session-continuity');
    initLastStopSnapshot(snapshotDir);

    const archiveStarted = deferred();
    const archiveBarrier = deferred();
    const gracefulFinished = deferred();
    const shutdown = createHarnessShutdownOperations({
      shutdownContinuitySync: () => continuityBeforeRestart.shutdown(),
      killActiveProcessesSync: () => undefined,
      stopRemoteServices: async () => undefined,
      terminateInstances: async () => {
        archiveStarted.resolve();
        await archiveBarrier.promise;
        await historyBeforeRestart.archiveInstance(sourceInstance, 'terminated');
      },
      flushChatTranscripts: async () => undefined,
      teardownBootstrap: async () => undefined,
      flushObservability: async () => undefined,
      runCleanupRegistry: async () => undefined,
      stopCliSpawnWorker: async () => undefined,
      killOrphanedCliProcesses: async () => undefined,
    });
    startGracefulQuitFlow({
      cleanupSync: shutdown.cleanupSync,
      cleanup: async () => { await shutdown.cleanup(); },
      preventDefault: () => undefined,
      quit: () => undefined,
      exit: () => undefined,
      timeoutMs: 10_000,
      onFinished: gracefulFinished.resolve,
      setTimeoutFn: (() => 1) as unknown as typeof setTimeout,
      clearTimeoutFn: () => undefined,
    });

    const shutdownSnapshot = new LastStopSnapshotManager(snapshotDir).getSnapshot();
    expect(shutdownSnapshot).toEqual({
      version: 2,
      writtenAt: BASE_TIME,
      sessions: [expect.objectContaining({
        instanceId: SOURCE_INSTANCE_ID,
        recoveryKey: `history:claude:${HISTORY_THREAD_ID}`,
        isLive: true,
        messageCount: 4,
        hasAssistantOutput: true,
      })],
    });
    const firstAsyncOutcome = await Promise.race([
      archiveStarted.promise.then(() => 'archive-started' as const),
      gracefulFinished.promise.then(() => 'graceful-finished' as const),
    ]);
    expect(firstAsyncOutcome).toBe('archive-started');
    archiveBarrier.reject(new Error('Simulated process termination at archive barrier'));
    await gracefulFinished.promise;

    const historyEntry = historyBeforeRestart.getEntries()[0];
    const continuityStateFile = path.join(snapshotDir, 'states', `${SOURCE_INSTANCE_ID}.json`);
    const continuityMetadataFile = path.join(
      snapshotDir, 'recovery-metadata', `${SOURCE_INSTANCE_ID}.json`,
    );
    const historyFiles = [
      path.join(historyBeforeRestart.getStoragePath(), 'index.json'),
      path.join(historyBeforeRestart.getStoragePath(), `${historyEntry.id}.json.gz`),
    ];
    const sourceFiles = [continuityStateFile, continuityMetadataFile, ...historyFiles];
    const sourceBytesAtRestart = await readBytes(sourceFiles);
    const continuityBytesAtRestart = await readBytes([
      continuityStateFile,
      continuityMetadataFile,
    ]);

    const restartedContinuity = new SessionContinuityManager({ autoSaveEnabled: false });
    const restartedHistory = new HistoryManager();
    managers.push(restartedContinuity);
    const liveInstances: Instance[] = [];
    let recoveryAttempt = 0;
    let successfulConfig: InstanceCreateConfig | undefined;
    let replacement: Instance | undefined;
    const coordinator = new ContinuityRecoveryCoordinator({
      createInstance: async (config) => instance(config as Partial<Instance>),
      createUnpublishedInstance: async (config) => {
        recoveryAttempt += 1;
        const created = instance({
          ...config,
          id: `fixture-replacement-${recoveryAttempt}`,
          status: 'idle',
          outputBuffer: config.initialOutputBuffer ?? [],
          readyPromise: recoveryAttempt === 1
            ? Promise.reject(new Error('Fixture provider startup failure'))
            : Promise.resolve(),
        } as Partial<Instance>);
        if (recoveryAttempt > 1) {
          successfulConfig = config;
          replacement = created;
        }
        return {
          instance: created,
          publish: async () => { liveInstances.push(created); },
          rollback: async () => undefined,
        };
      },
      getAllInstances: () => liveInstances,
      queueContinuityPreamble: () => undefined,
      clearPrivateState: () => undefined,
    });
    const lastStop = new LastStopSnapshotManager(snapshotDir);
    const recovery = initializeSessionRecoveryCandidateService({
      getSnapshot: () => lastStop.getSnapshot(),
      waitForContinuityReady: () => restartedContinuity.waitForRecoveryDiscoveryReady(),
      listContinuityMetadata: (modifiedSince, preferredInstanceIds) =>
        restartedContinuity.listContinuityRecoveryMetadata(modifiedSince, preferredInstanceIds),
      loadContinuityState: (sourceInstanceId) =>
        restartedContinuity.loadRecoveryState(sourceInstanceId),
      waitForHistoryReady: () => restartedHistory.startupTasks,
      getHistoryCoverage: (identities) => restartedHistory.getRecoveryCoverage(identities),
      loadHistoryConversation: (entryId) => restartedHistory.loadConversation(entryId),
      getLiveRecoveryKeys: () => coordinator.getLiveRecoveryKeys(),
      now: () => BASE_TIME,
    });

    const candidates = await recovery.listCandidates();
    expect(candidates).toEqual([
      expect.objectContaining({
        recoveryKey: `history:claude:${HISTORY_THREAD_ID}`,
        sourceInstanceId: SOURCE_INSTANCE_ID,
        reason: 'newer-than-history',
        recoveredMessageCount: 2,
      }),
    ]);
    await expectBytes(sourceBytesAtRestart);

    const resolved = await recovery.resolveCandidate(candidates[0].recoveryKey);
    await expect(coordinator.recover(resolved)).rejects.toThrow(
      'Recovery replacement failed to start',
    );
    await expectBytes(sourceBytesAtRestart);
    await expect(recovery.listCandidates()).resolves.toHaveLength(1);

    const result = await coordinator.recover(resolved);
    expect(result).toMatchObject({
      instanceId: 'fixture-replacement-2',
      recoveredMessageCount: 2,
      usedNativeResume: false,
    });
    expect(result.instanceId).not.toBe(SOURCE_INSTANCE_ID);
    expect(successfulConfig?.initialOutputBuffer?.map((message) => message.id)).toEqual([
      'archive-user',
      'archive-assistant',
      'suffix-earlier',
      'suffix-later',
    ]);
    await expect(recovery.listCandidates()).resolves.toEqual([]);
    await expectBytes(sourceBytesAtRestart);

    expect(replacement).toBeDefined();
    replacement!.status = 'terminated';
    liveInstances.splice(0);
    await restartedHistory.archiveInstance(replacement!, 'completed');
    await expect(fs.promises.access(continuityStateFile)).resolves.toBeUndefined();
    await expectBytes(continuityBytesAtRestart);
    await expect(restartedHistory.loadConversation(historyEntry.id)).resolves.toMatchObject({
      messages: [
        { id: 'archive-user' },
        { id: 'archive-assistant' },
        { id: 'suffix-earlier' },
        { id: 'suffix-later' },
      ],
    });
    await expect(recovery.listCandidates()).resolves.toEqual([]);
    getSessionContinuityManagerIfInitialized()?.shutdown();
  });
});

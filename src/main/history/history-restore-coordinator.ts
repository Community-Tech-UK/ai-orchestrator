import {
  getConversationHistoryTitle,
  inferConversationHistoryProvider,
  type HistoryRestoreMode,
} from '../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { generateId } from '../../shared/utils/id-generator';
import type { InstanceManager } from '../instance/instance-manager';
import { planSessionRecovery } from '../instance/lifecycle/session-recovery';
import { getLogger } from '../logging/logger';
import { getOutputStorageManager } from '../memory/output-storage';
import { buildReplayContinuityMessage } from '../session/replay-continuity';
import { getHistoryManager, type HistoryManager } from './history-manager';
import {
  getMessagesForRestoreTranscript,
  getNativeResumeSessionId,
  getOriginalSessionIdFromRestoreNotices,
  getProviderDisplayName,
  selectMessagesForRestore,
} from './history-restore-helpers';

const logger = getLogger('HistoryRestoreCoordinator');
const DEFAULT_POLL_INTERVAL_MS = 200;

export interface HistoryRestoreForkIds {
  sessionId: string;
  historyThreadId: string;
}

export interface HistoryRestoreCoordinatorOptions {
  workingDirectory?: string;
  forkAs?: HistoryRestoreForkIds;
  forceFallback?: boolean;
}

export interface HistoryRestoreCoordinatorResult {
  instanceId: string;
  restoredMessages: OutputMessage[];
  restoreMode: HistoryRestoreMode;
  sessionId: string;
  historyThreadId: string;
}

export class HistoryRestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HistoryRestoreError';
  }
}

type HistoryRestoreHistoryDep = Pick<HistoryManager, 'loadConversation' | 'markNativeResumeFailed'>;
type OutputStorageDep = Pick<ReturnType<typeof getOutputStorageManager>, 'storeMessages'>;

export interface HistoryRestoreCoordinatorDeps {
  history?: () => HistoryRestoreHistoryDep;
  outputStorage?: () => OutputStorageDep;
  isRemoteNodeReachable?: (nodeId: string) => boolean;
  postSpawnTimeoutMs?: number;
  pollIntervalMs?: number;
}

export class HistoryRestoreCoordinator {
  private readonly history: () => HistoryRestoreHistoryDep;
  private readonly outputStorage: () => OutputStorageDep;
  private readonly isRemoteNodeReachable: (nodeId: string) => boolean;
  private readonly postSpawnTimeoutMs?: number;
  private readonly pollIntervalMs: number;

  constructor(deps: HistoryRestoreCoordinatorDeps = {}) {
    this.history = deps.history ?? getHistoryManager;
    this.outputStorage = deps.outputStorage ?? getOutputStorageManager;
    this.isRemoteNodeReachable = deps.isRemoteNodeReachable ?? (() => true);
    this.postSpawnTimeoutMs = deps.postSpawnTimeoutMs;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async restore(
    instanceManager: InstanceManager,
    entryId: string,
    opts: HistoryRestoreCoordinatorOptions = {},
  ): Promise<HistoryRestoreCoordinatorResult> {
    const data = await this.history().loadConversation(entryId);
    if (!data) {
      throw new HistoryRestoreError('HISTORY_NOT_FOUND', `History entry ${entryId} not found`);
    }

    const workingDir = opts.workingDirectory || data.entry.workingDirectory;
    const restoreTranscriptMessages = getMessagesForRestoreTranscript(data.messages);
    const displayName = getConversationHistoryTitle(data.entry);
    const historyThreadId =
      opts.forkAs?.historyThreadId ||
      data.entry.historyThreadId ||
      data.entry.sessionId ||
      data.entry.id;
    const restoreProvider = inferConversationHistoryProvider(data.entry);
    const restoreModel = data.entry.currentModel?.trim() || undefined;
    const nativeResumeSessionId = opts.forkAs || opts.forceFallback
      ? undefined
      : getNativeResumeSessionId(data.entry, data.messages, restoreProvider);
    const restoreNodeId = data.entry.executionLocation?.type === 'remote'
      ? data.entry.executionLocation.nodeId
      : undefined;
    const remoteNodeAvailable = restoreNodeId
      ? this.isRemoteNodeReachable(restoreNodeId)
      : true;

    const recoveryPlan = planSessionRecovery({
      instanceId: entryId,
      reason: 'history-restore',
      previousProviderSessionId: nativeResumeSessionId,
      provider: restoreProvider,
      model: restoreModel,
      cwd: workingDir,
      yolo: false,
      executionLocation: restoreNodeId ? 'remote' : 'local',
      capabilities: {
        supportsResume: Boolean(nativeResumeSessionId) && remoteNodeAvailable,
        supportsForkSession: false,
      },
      adapterGeneration: 0,
      hasConversation: restoreTranscriptMessages.some(
        (message) => message.type === 'user' || message.type === 'assistant',
      ),
      sessionResumeBlacklisted: Boolean(data.entry.nativeResumeFailedAt && !nativeResumeSessionId),
    });
    const canAttemptNativeResume =
      Boolean(nativeResumeSessionId) &&
      remoteNodeAvailable &&
      (recoveryPlan.kind === 'native-resume' || recoveryPlan.kind === 'provider-fork');

    if (canAttemptNativeResume && nativeResumeSessionId) {
      const native = await this.tryNativeResume({
        instanceManager,
        workingDir,
        displayName,
        isRenamed: data.entry.isRenamed,
        historyThreadId,
        nativeResumeSessionId,
        restoreTranscriptMessages,
        restoreProvider,
        restoreModel,
        restoreNodeId,
      });
      if (native) {
        return native;
      }

      try {
        await this.history().markNativeResumeFailed(entryId);
      } catch (error) {
        logger.warn('History restore: failed to persist native resume failure state', {
          entryId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.restoreFallback({
      instanceManager,
      entryId,
      workingDir,
      displayName,
      isRenamed: data.entry.isRenamed,
      historyThreadId,
      forkSessionId: opts.forkAs?.sessionId,
      restoreTranscriptMessages,
      restoreProvider,
      restoreModel,
      restoreNodeId,
      remoteNodeAvailable,
      canAttemptNativeResume,
      nativeResumeSessionId,
      originalSessionId: data.entry.sessionId,
      storedMessages: data.messages,
    });
  }

  private async tryNativeResume(params: {
    instanceManager: InstanceManager;
    workingDir: string;
    displayName: string;
    isRenamed?: boolean;
    historyThreadId: string;
    nativeResumeSessionId: string;
    restoreTranscriptMessages: OutputMessage[];
    restoreProvider: Instance['provider'];
    restoreModel?: string;
    restoreNodeId?: string;
  }): Promise<HistoryRestoreCoordinatorResult | null> {
    let resumeInstanceId: string | undefined;
    const postSpawnTimeoutMs = this.postSpawnTimeoutMs ?? (params.restoreNodeId ? 15_000 : 5_000);

    try {
      const instance = await params.instanceManager.createInstance({
        workingDirectory: params.workingDir,
        displayName: params.displayName,
        isRenamed: params.isRenamed,
        historyThreadId: params.historyThreadId,
        sessionId: params.nativeResumeSessionId,
        resume: true,
        initialOutputBuffer: params.restoreTranscriptMessages,
        provider: params.restoreProvider,
        modelOverride: params.restoreModel,
        forceNodeId: params.restoreNodeId,
      });
      resumeInstanceId = instance.id;
      instance.autoRespawnSuppressedUntil = Date.now() + postSpawnTimeoutMs + 2_000;

      try {
        await instance.readyPromise;
      } catch {
        throw new Error('Instance initialization failed during resume');
      }

      const resumeState = await this.waitForResumeState(
        params.instanceManager,
        instance.id,
        postSpawnTimeoutMs,
      );
      if (resumeState.alive) {
        instance.autoRespawnSuppressedUntil = undefined;

        if (resumeState.confirmed) {
          return {
            instanceId: instance.id,
            restoredMessages: instance.outputBuffer,
            restoreMode: 'native-resume',
            sessionId: params.nativeResumeSessionId,
            historyThreadId: params.historyThreadId,
          };
        }

        const preamble = buildReplayContinuityMessage(
          params.restoreTranscriptMessages,
          { reason: 'resume-unconfirmed' },
        );
        if (preamble) {
          params.instanceManager.queueContinuityPreamble(instance.id, preamble);
        }
        return {
          instanceId: instance.id,
          restoredMessages: instance.outputBuffer,
          restoreMode: 'resume-unconfirmed',
          sessionId: params.nativeResumeSessionId,
          historyThreadId: params.historyThreadId,
        };
      }

      await this.cleanupFailedNativeResume(params.instanceManager, instance);
      return null;
    } catch (error) {
      logger.warn('History restore: native resume attempt failed', {
        resumeInstanceId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (resumeInstanceId) {
        const staleInstance = params.instanceManager.getInstance(resumeInstanceId);
        if (staleInstance) {
          staleInstance.outputBuffer = [];
          staleInstance.autoRespawnSuppressedUntil = undefined;
        }
        try {
          await params.instanceManager.terminateInstance(resumeInstanceId, false);
        } catch {
          // Ignore cleanup errors.
        }
      }
      return null;
    }
  }

  private waitForResumeState(
    instanceManager: InstanceManager,
    instanceId: string,
    postSpawnTimeoutMs: number,
  ): Promise<{ alive: boolean; confirmed: boolean }> {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
      };
      const complete = (value: { alive: boolean; confirmed: boolean }): void => {
        if (!settled) {
          cleanup();
          resolve(value);
        }
      };
      const inspect = (): { alive: boolean; confirmed: boolean } => {
        const inst = instanceManager.getInstance(instanceId);
        const alive = inst != null
          && inst.status !== 'error'
          && inst.status !== 'terminated'
          && inst.status !== 'respawning';
        const confirmed = Boolean(inst?.contextUsage && inst.contextUsage.used > 0);
        return { alive, confirmed };
      };

      const timeout = setTimeout(() => {
        complete(inspect());
      }, postSpawnTimeoutMs);

      const poll = setInterval(() => {
        const state = inspect();
        if (!state.alive || state.confirmed) {
          complete(state);
        }
      }, this.pollIntervalMs);
    });
  }

  private async cleanupFailedNativeResume(
    instanceManager: InstanceManager,
    instance: Instance,
  ): Promise<void> {
    const currentInstance = instanceManager.getInstance(instance.id);
    instance.autoRespawnSuppressedUntil = undefined;
    if (currentInstance) {
      currentInstance.outputBuffer = [];
    }
    try {
      await instanceManager.terminateInstance(instance.id, false);
    } catch {
      // Ignore cleanup errors.
    }
  }

  private async restoreFallback(params: {
    instanceManager: InstanceManager;
    entryId: string;
    workingDir: string;
    displayName: string;
    isRenamed?: boolean;
    historyThreadId: string;
    forkSessionId?: string;
    restoreTranscriptMessages: OutputMessage[];
    restoreProvider: Instance['provider'];
    restoreModel?: string;
    restoreNodeId?: string;
    remoteNodeAvailable: boolean;
    canAttemptNativeResume: boolean;
    nativeResumeSessionId?: string;
    originalSessionId: string;
    storedMessages: OutputMessage[];
  }): Promise<HistoryRestoreCoordinatorResult> {
    const { selected: displayMessages, hidden: hiddenMessages, truncatedCount } =
      selectMessagesForRestore(params.restoreTranscriptMessages, 100);
    const fallbackNodeId = params.remoteNodeAvailable ? params.restoreNodeId : undefined;
    const fallbackWorkingDir = (params.restoreNodeId && !params.remoteNodeAvailable)
      ? process.cwd()
      : params.workingDir;

    const instance = await params.instanceManager.createInstance({
      workingDirectory: fallbackWorkingDir,
      displayName: params.displayName,
      isRenamed: params.isRenamed,
      historyThreadId: params.historyThreadId,
      sessionId: params.forkSessionId,
      initialOutputBuffer: displayMessages,
      provider: params.restoreProvider,
      modelOverride: params.restoreModel,
      forceNodeId: fallbackNodeId,
    });

    let canLoadEarlierMessages = hiddenMessages.length > 0;
    if (canLoadEarlierMessages) {
      try {
        await this.outputStorage().storeMessages(instance.id, hiddenMessages);
      } catch (error) {
        canLoadEarlierMessages = false;
        logger.error(
          'History restore: failed to persist truncated messages',
          error instanceof Error ? error : undefined,
          {
            instanceId: instance.id,
            storedCount: hiddenMessages.length,
          },
        );
      }
    }

    const replayContinuity = buildReplayContinuityMessage(params.restoreTranscriptMessages, {
      reason: params.canAttemptNativeResume ? 'history-restore-fallback' : 'history-restore-replay',
    });
    if (replayContinuity) {
      params.instanceManager.queueContinuityPreamble(instance.id, replayContinuity);
    }

    const providerName = getProviderDisplayName(params.restoreProvider);
    const originalSessionId =
      (params.canAttemptNativeResume
        ? params.nativeResumeSessionId
        : getOriginalSessionIdFromRestoreNotices(params.storedMessages))
      || params.originalSessionId;
    const systemMessage: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: truncatedCount > 0 && canLoadEarlierMessages
        ? `Previous ${providerName} CLI session could not be restored natively. Your conversation history is displayed above (${truncatedCount} earlier messages available via "Load earlier messages"), and a condensed transcript will be attached automatically to your next message.`
        : truncatedCount > 0
          ? `Previous ${providerName} CLI session could not be restored natively. The latest ${displayMessages.length} messages are displayed above, and a condensed transcript of the earlier conversation will be attached automatically to your next message.`
          : `Previous ${providerName} CLI session could not be restored natively. Your conversation history is displayed above, and a condensed transcript will be attached automatically to your next message.`,
      metadata: {
        isRestoreNotice: true,
        systemMessageKind: 'restore-fallback',
        provider: params.restoreProvider,
        restoredMessageCount: params.restoreTranscriptMessages.length,
        hiddenMessageCount: hiddenMessages.length,
        continuityInjectionQueued: Boolean(replayContinuity),
        nativeResumeFailedAt: params.canAttemptNativeResume ? Date.now() : null,
        originalSessionId,
        restoreNodeId: params.restoreNodeId ?? null,
        remoteNodeAvailable: params.restoreNodeId ? params.remoteNodeAvailable : undefined,
      },
    };
    instance.outputBuffer.push(systemMessage);

    return {
      instanceId: instance.id,
      restoredMessages: [...displayMessages, systemMessage],
      restoreMode: 'replay-fallback',
      sessionId: params.forkSessionId || instance.sessionId,
      historyThreadId: params.historyThreadId,
    };
  }
}

let singleton: HistoryRestoreCoordinator | null = null;

export function getHistoryRestoreCoordinator(): HistoryRestoreCoordinator {
  singleton ??= new HistoryRestoreCoordinator();
  return singleton;
}

export function _resetHistoryRestoreCoordinatorForTesting(): void {
  singleton = null;
}

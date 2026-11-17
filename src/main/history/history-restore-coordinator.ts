import {
  getConversationHistoryTitle,
  inferConversationHistoryProvider,
  type HistoryRestoreMode,
} from '../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { MemberSessionPolicy } from '../mobile-gateway/mobile-gateway-member-session';
import { SET_ASIDE_FOLDER_METADATA } from '../../shared/utils/plan-queue-set-aside-agent';
import { resolveMemberRestore } from './history-restore-member';
import { isToolOutcomeMessage } from '../../shared/types/tool-outcome';
import { normalizeRecoveryNodePlacement } from '../session/session-recovery-node-placement';
import { normalizeOpenCodeAdditionalDirectories } from '../../shared/utils/opencode-additional-directories';
import { generateId } from '../../shared/utils/id-generator';
import type { InstanceManager } from '../instance/instance-manager';
import { recordToolOutcome } from '../learning/tool-outcome-store';
import { planSessionRecovery } from '../instance/lifecycle/session-recovery';
import { getLogger } from '../logging/logger';
import { getOutputStorageManager } from '../memory/output-storage';
import { buildReplayContinuityMessage } from '../session/replay-continuity';
import { buildHandoffDocumentFromMessages } from '../session/handoff-state-service';
import { getSettingsManager } from '../core/config/settings-manager';
import { getHistoryManager, type HistoryManager } from './history-manager';
import {
  getMessagesForRestoreTranscript,
  getNativeResumeSessionId,
  getOriginalSessionIdFromRestoreNotices,
  getProviderDisplayName,
  resolveRestoreAccount,
  selectMessagesForRestore,
} from './history-restore-helpers';
import { waitForResumeState } from './history-restore-resume-wait';

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
  /** Account to continue on. A different account replays instead of native-resuming. */
  accountProfileId?: string;
}

export interface HistoryRestoreCoordinatorResult {
  instanceId: string;
  restoredMessages: OutputMessage[];
  restoreMode: HistoryRestoreMode;
  sessionId: string;
  historyThreadId: string;
}

/**
 * Outcome of the native-resume rung.
 *
 * `session-dead` means the provider was reached and the resumed session did not
 * survive — evidence that the archived handle is spent, so it gets blacklisted.
 * `infrastructure` means the spawn never got that far (CLI detection timeout,
 * spawn failure, cold-start starvation): nothing was learned about the handle,
 * so it must be kept for the next attempt.
 */
type NativeResumeAttempt =
  | {
      kind: 'restored';
      result: HistoryRestoreCoordinatorResult;
      /**
       * The instance is alive and usable, but the adapter proved the native
       * resume did not happen, so the archived handle is spent and must be
       * blacklisted even though the rung is not demoted (LT-014).
       */
      markResumeFailed?: boolean;
    }
  | { kind: 'session-dead' }
  | { kind: 'infrastructure'; error: string };

/**
 * Restore-side hydration-ladder bottom rung (spec item 5): prefer the
 * handoff-document render of the archived transcript when the feature is ON;
 * fall through to the replay preamble otherwise (OFF ⇒ byte-identical).
 */
function buildRestoreContinuityPreamble(
  messages: OutputMessage[],
  reason: string,
  meta: { workingDir?: string; restoreProvider?: Instance['provider']; restoreModel?: string },
): string | null {
  try {
    if (getSettingsManager().getAll().sessionHandoffStateEnabled) {
      const handoff = buildHandoffDocumentFromMessages(messages, {
        reason,
        workingDirectory: meta.workingDir,
        provider: meta.restoreProvider,
        model: meta.restoreModel,
      });
      if (handoff) return handoff;
    }
  } catch (error) {
    logger.warn('Handoff render failed during restore; using replay preamble', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return buildReplayContinuityMessage(messages, { reason });
}

/**
 * Notice for a resume the adapter definitively disproved while the instance
 * stayed alive (LT-014).
 *
 * Deliberately shares the replay rung's wording, `isRestoreNotice` flag and
 * `restore-fallback` kind: both mean "the provider did not resume natively".
 * The shared shape is what keeps `getMessagesForRestoreTranscript` from
 * replaying this notice into a later transcript, and what lets
 * `getOriginalSessionIdFromRestoreNotices` still name the original session if
 * THIS instance is re-archived and that thread later lands on the replay rung.
 * (It does not help a re-restore of the entry being restored right now — that
 * entry was archived before this notice existed.)
 */
function buildDisprovenResumeNotice(
  params: {
    restoreProvider: Instance['provider'];
    restoreTranscriptMessages: OutputMessage[];
    nativeResumeSessionId: string;
    restoreNodeId?: string;
  },
  continuityInjectionQueued: boolean,
  hiddenMessageCount: number,
): OutputMessage {
  const providerName = getProviderDisplayName(params.restoreProvider);
  const earlier = hiddenMessageCount > 0 ? ` (${hiddenMessageCount} earlier messages available via "Load earlier messages")` : '';
  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'system',
    content: `Previous ${providerName} CLI session could not be restored natively. Your conversation history is displayed above${earlier}, and a condensed transcript will be attached automatically to your next message.`,
    metadata: {
      isRestoreNotice: true,
      systemMessageKind: 'restore-fallback',
      provider: params.restoreProvider,
      restoredMessageCount: params.restoreTranscriptMessages.length,
      hiddenMessageCount,
      continuityInjectionQueued,
      nativeResumeFailedAt: Date.now(),
      originalSessionId: params.nativeResumeSessionId,
      restoreNodeId: params.restoreNodeId ?? null,
    },
  };
}

/**
 * LT-196: the restore transcript drops `tool_outcome` records, which never
 * belong in `outputBuffer`. Re-archiving the thread overwrites this entry, so
 * hand them to the restored instance's side store or the miner loses them.
 */
function reseedToolOutcomes(
  result: HistoryRestoreCoordinatorResult,
  archivedMessages: readonly OutputMessage[],
): HistoryRestoreCoordinatorResult {
  for (const message of archivedMessages) {
    if (isToolOutcomeMessage(message)) recordToolOutcome(result.instanceId, message);
  }
  return result;
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
type OutputStorageDep = Pick<ReturnType<typeof getOutputStorageManager>, 'storeMessages' | 'deleteInstance'>;

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

  /**
   * Restore an archived conversation, then record which rung of the ladder it
   * landed on. The rung was previously visible only in the IPC result and the
   * rendered transcript, which made the restore live-test checks impossible to
   * judge from the app log (LT-011). One line at the single exit point covers
   * every rung — native-resume, resume-unconfirmed and replay-fallback.
   */
  async restore(
    instanceManager: InstanceManager,
    entryId: string,
    opts: HistoryRestoreCoordinatorOptions = {},
  ): Promise<HistoryRestoreCoordinatorResult> {
    const result = await this.restoreInternal(instanceManager, entryId, opts);
    logger.info('History restore complete', {
      entryId,
      restoreMode: result.restoreMode,
      instanceId: result.instanceId,
      sessionId: result.sessionId,
      historyThreadId: result.historyThreadId,
    });
    return result;
  }

  private async restoreInternal(
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
    const historyThreadId = opts.forkAs?.historyThreadId || data.entry.historyThreadId?.trim();
    if (!historyThreadId) {
      throw new HistoryRestoreError(
        'HISTORY_IDENTITY_MISSING',
        `History entry ${entryId} has no app-owned history identity`,
      );
    }
    const restoreProvider = inferConversationHistoryProvider(data.entry);
    const restoreAdditionalDirectories = normalizeOpenCodeAdditionalDirectories(data.entry.additionalDirectories, restoreProvider);
    const restoreNodePlacement = normalizeRecoveryNodePlacement(data.entry.nodePlacement);
    const restoreModel = data.entry.currentModel?.trim() || undefined;
    const restoreRuntimeSummary = data.entry.runtimeSummary;
    const restoreBrowserToolsMode = data.entry.browserToolsMode;
    const restoreHardened = data.entry.hardened;
    // A Copilot thread resumes under the SAME GitHub account it was created
    // with. Restoring it under the current default would send this
    // conversation's context through a different identity.
    const restoreCopilotProfileId = data.entry.copilotAccountProfileId;
    const accountPlan = resolveRestoreAccount({
      storedAccountProfileId: data.entry.accountProfileId,
      requestedAccountProfileId: opts.accountProfileId,
    });
    const restoreAccountProfileId = accountPlan.nativeAccountProfileId;
    const nativeResumeSessionId = opts.forkAs || opts.forceFallback || accountPlan.forceReplay
      ? undefined
      : getNativeResumeSessionId(data.entry);
    const restoreNodeId = data.entry.executionLocation?.type === 'remote'
      ? data.entry.executionLocation.nodeId
      : undefined;
    const remoteNodeAvailable = restoreNodeId
      ? this.isRemoteNodeReachable(restoreNodeId)
      : true;

    const { policy: memberPolicy, problem } = resolveMemberRestore(data.entry.mobileProfileId, restoreNodeId, remoteNodeAvailable);
    if (problem) throw new HistoryRestoreError(problem.code, problem.message);
    // The Sort out agent reopened from History keeps its Plan Queue tools. A fork is a new conversation, not that agent.
    const setAsideFolder = opts.forkAs ? undefined : data.entry.planQueueSetAsideFolder;
    const sessionPolicy: Partial<MemberSessionPolicy> | undefined = setAsideFolder
      ? { ...memberPolicy, metadata: { ...memberPolicy?.metadata, [SET_ASIDE_FOLDER_METADATA]: setAsideFolder } }
      : memberPolicy;

    if (!remoteNodeAvailable && restoreAdditionalDirectories?.length) {
      throw new HistoryRestoreError('ADDITIONAL_DIRECTORIES_NODE_UNAVAILABLE', 'This session has additional folders on an unavailable worker. Restore it when that worker is available.');
    }

    if (!remoteNodeAvailable && restoreNodePlacement?.requiresOpenCodeMajor) throw new HistoryRestoreError('OPENCODE_NODE_UNAVAILABLE', 'Restore this version-constrained session when its original worker is available.');
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
      const attempt = await this.tryNativeResume({
        instanceManager,
        workingDir,
        displayName,
        isRenamed: data.entry.isRenamed,
        historyThreadId,
        nativeResumeSessionId,
        restoreTranscriptMessages,
        restoreProvider,
        restoreAdditionalDirectories, restoreNodePlacement,
        restoreModel,
        restoreRuntimeSummary,
        restoreBrowserToolsMode,
        restoreHardened,
        restoreCopilotProfileId,
        restoreAccountProfileId,
        restoreNodeId,
        sessionPolicy,
      });
      if (attempt.kind === 'restored') {
        // An alive-but-disproven resume keeps its rung but still burns the
        // handle: without this, every later restore re-attempts the same
        // doomed native resume (LT-014).
        if (attempt.markResumeFailed) {
          await this.recordNativeResumeFailure(entryId);
        }
        return reseedToolOutcomes(attempt.result, data.messages);
      }

      if (attempt.kind === 'session-dead') {
        await this.recordNativeResumeFailure(entryId);
      } else {
        // Do NOT blacklist the archived session handle: the failure was local
        // (CLI detection timeout, spawn error, starved cold start), so the
        // provider never got a chance to accept or reject it. Blacklisting here
        // would permanently downgrade this thread to replay fallback because of
        // a transient host hiccup.
        logger.warn('History restore: keeping native session handle after an infrastructure failure', {
          entryId,
          error: attempt.error,
        });
      }
    }

    return reseedToolOutcomes(await this.restoreFallback({
      instanceManager,
      entryId,
      workingDir,
      displayName,
      isRenamed: data.entry.isRenamed,
      historyThreadId,
      forkSessionId: opts.forkAs?.sessionId,
      restoreTranscriptMessages,
      restoreProvider,
      restoreAdditionalDirectories, restoreNodePlacement,
      restoreModel,
      restoreRuntimeSummary,
      restoreBrowserToolsMode,
      restoreHardened,
      restoreCopilotProfileId,
      restoreNodeId,
      remoteNodeAvailable,
      canAttemptNativeResume,
      nativeResumeSessionId,
      originalSessionId: data.entry.sessionId,
      storedMessages: data.messages,
      explicitAccountProfileId: accountPlan.explicitAccountProfileId,
      sessionPolicy,
    }), data.messages);
  }

  /**
   * Blacklist the archived session handle. Never called for an infrastructure
   * failure: the provider was never asked, so nothing was learned about the
   * handle and keeping it is what stops a transient host hiccup from
   * permanently downgrading the thread to replay.
   */
  private async recordNativeResumeFailure(entryId: string): Promise<void> {
    try {
      await this.history().markNativeResumeFailed(entryId);
    } catch (error) {
      logger.warn('History restore: failed to persist native resume failure state', {
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    restoreAdditionalDirectories?: string[];
    restoreNodePlacement?: Instance['nodePlacement'];
    restoreModel?: string;
    restoreRuntimeSummary?: Instance['runtimeSummary'];
    restoreBrowserToolsMode?: Instance['browserToolsMode'];
    restoreHardened?: boolean;
    restoreCopilotProfileId?: string;
    restoreAccountProfileId?: string;
    restoreNodeId?: string;
    /** A phone member's fence and stamp, and the Sort out marker: what the session carries beyond its transcript. */
    sessionPolicy?: Partial<MemberSessionPolicy>;
  }): Promise<NativeResumeAttempt> {
    let resumeInstanceId: string | undefined;
    const postSpawnTimeoutMs = this.postSpawnTimeoutMs ?? (params.restoreNodeId ? 15_000 : 5_000);
    // Only the newest messages go in memory, as on the replay rung; the rest go to disk storage, where "Load earlier
    // messages" and archiving read them. A new session is sent to the window whole, and sending a long transcript froze
    // the main process: 89 s for five long sessions restored together after a restart (16 Nov 2026).
    const { selected: visibleMessages, hidden: earlierMessages } = selectMessagesForRestore(params.restoreTranscriptMessages);

    try {
      const instance = await params.instanceManager.createInstance({
        workingDirectory: params.workingDir,
        displayName: params.displayName,
        isRenamed: params.isRenamed,
        isRestoredSession: true,
        historyThreadId: params.historyThreadId,
        sessionId: params.nativeResumeSessionId,
        resume: true,
        initialOutputBuffer: visibleMessages,
        provider: params.restoreProvider,
        additionalDirectories: normalizeOpenCodeAdditionalDirectories(params.restoreAdditionalDirectories, params.restoreProvider),
        nodePlacement: normalizeRecoveryNodePlacement(params.restoreNodePlacement),
        modelOverride: params.restoreModel,
        runtimeSummary: params.restoreRuntimeSummary,
        browserToolsMode: params.restoreBrowserToolsMode,
        hardened: params.restoreHardened,
      copilotAccountProfileId: params.restoreCopilotProfileId,
        accountProfileId: params.restoreAccountProfileId,
        forceNodeId: params.restoreNodeId,
        ...params.sessionPolicy,
      });
      resumeInstanceId = instance.id;
      instance.autoRespawnSuppressedUntil = Date.now() + postSpawnTimeoutMs + 2_000;
      // Background setup clears `readyPromise` when it ends, so take it before waiting on the write: read afterwards, a
      // setup failure would look like a dead session and wrongly mark the thread unresumable.
      const ready = instance.readyPromise;
      await Promise.all([
        earlierMessages.length > 0 ? this.outputStorage().storeMessages(instance.id, earlierMessages) : undefined,
        (async () => {
          try {
            await ready;
          } catch (error) {
            // Keep the underlying reason (e.g. "Timeout checking Codex CLI"): it is
            // what tells a later reader whether the session or the host failed.
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Instance initialization failed during resume: ${reason}`);
          }
        })(),
      ]);

      const resumeState = await waitForResumeState(params.instanceManager, instance.id, postSpawnTimeoutMs, this.pollIntervalMs);
      if (resumeState.alive) {
        instance.autoRespawnSuppressedUntil = undefined;

        if (resumeState.confirmed) {
          return {
            kind: 'restored',
            result: {
              instanceId: instance.id,
              restoredMessages: instance.outputBuffer,
              restoreMode: 'native-resume',
              sessionId: params.nativeResumeSessionId,
              historyThreadId: params.historyThreadId,
            },
          };
        }

        const preamble = buildRestoreContinuityPreamble(
          params.restoreTranscriptMessages,
          'resume-unconfirmed',
          params,
        );
        if (preamble) {
          params.instanceManager.queueContinuityPreamble(instance.id, preamble);
        }

        // Disproven ⇒ tell the user. The process is alive and usable, but the
        // provider lost its native memory of this conversation, and only the
        // queued preamble carries it forward. Staying silent here let the user
        // believe the CLI still remembered everything (LT-014).
        if (resumeState.disproven) {
          instance.outputBuffer.push(
            buildDisprovenResumeNotice(params, Boolean(preamble), earlierMessages.length),
          );
        }

        return {
          kind: 'restored',
          markResumeFailed: resumeState.disproven,
          result: {
            instanceId: instance.id,
            restoredMessages: instance.outputBuffer,
            restoreMode: 'resume-unconfirmed',
            sessionId: params.nativeResumeSessionId,
            historyThreadId: params.historyThreadId,
          },
        };
      }

      await this.discardRestoreAttempt(params.instanceManager, instance.id);
      return { kind: 'session-dead' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('History restore: native resume attempt failed', {
        resumeInstanceId,
        error: errorMessage,
      });

      if (resumeInstanceId) {
        await this.discardRestoreAttempt(params.instanceManager, resumeInstanceId);
      }
      return { kind: 'infrastructure', error: errorMessage };
    }
  }

  /**
   * Terminate a native-resume attempt that did not take. Sessions adopted
   * under it while it was live (a Plan Queue run follows its restored parent
   * as soon as the session appears) are released, not terminated with it:
   * the replacement restore of the same thread adopts them. Its buffer and
   * stored messages are emptied so the archive on termination is refused by
   * `shouldArchiveInstance` (`empty-transcript-over-history`) instead of
   * replacing the thread's entry.
   */
  private async discardRestoreAttempt(instanceManager: InstanceManager, instanceId: string): Promise<void> {
    const attempt = instanceManager.getInstance(instanceId);
    if (attempt) {
      attempt.outputBuffer = [];
      attempt.autoRespawnSuppressedUntil = undefined;
      attempt.terminationPolicy = 'orphan-children';
    }
    // Archiving also reads the attempt's stored earlier messages, so they go too, or they would replace the thread's entry.
    await this.outputStorage().deleteInstance(instanceId);
    try {
      await instanceManager.terminateInstance(instanceId, false);
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
    restoreAdditionalDirectories?: string[];
    restoreNodePlacement?: Instance['nodePlacement'];
    restoreModel?: string;
    restoreRuntimeSummary?: Instance['runtimeSummary'];
    restoreBrowserToolsMode?: Instance['browserToolsMode'];
    restoreHardened?: boolean;
    restoreCopilotProfileId?: string;
    restoreNodeId?: string;
    remoteNodeAvailable: boolean;
    canAttemptNativeResume: boolean;
    nativeResumeSessionId?: string;
    originalSessionId: string;
    storedMessages: OutputMessage[];
    explicitAccountProfileId?: string;
    /** A phone member's fence and stamp, and the Sort out marker: what the session carries beyond its transcript. */
    sessionPolicy?: Partial<MemberSessionPolicy>;
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
      isRestoredSession: true,
      historyThreadId: params.historyThreadId,
      sessionId: params.forkSessionId,
      // Copy: the restore notice is pushed onto the instance's buffer below, and
      // `displayMessages` is still read when building `restoredMessages`. Sharing
      // one array showed the notice twice in the renderer.
      initialOutputBuffer: [...displayMessages],
      provider: params.restoreProvider,
      additionalDirectories: normalizeOpenCodeAdditionalDirectories(params.restoreAdditionalDirectories, params.restoreProvider),
      nodePlacement: normalizeRecoveryNodePlacement(params.restoreNodePlacement),
      modelOverride: params.restoreModel,
      runtimeSummary: params.restoreRuntimeSummary,
      browserToolsMode: params.restoreBrowserToolsMode,
      hardened: params.restoreHardened,
      copilotAccountProfileId: params.restoreCopilotProfileId,
      ...(params.explicitAccountProfileId ? { accountProfileId: params.explicitAccountProfileId } : {}),
      forceNodeId: fallbackNodeId,
      ...params.sessionPolicy,
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

    const replayContinuity = buildRestoreContinuityPreamble(
      params.restoreTranscriptMessages,
      params.canAttemptNativeResume ? 'history-restore-fallback' : 'history-restore-replay',
      params,
    );
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

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
import { buildHandoffDocumentFromMessages } from '../session/handoff-state-service';
import { getSettingsManager } from '../core/config/settings-manager';
import { getHistoryManager, type HistoryManager } from './history-manager';
import {
  getMessagesForRestoreTranscript,
  getNativeResumeSessionId,
  getOriginalSessionIdFromRestoreNotices,
  getProviderDisplayName,
  selectMessagesForRestore,
} from './history-restore-helpers';
import type { ResumeAttemptResult } from '../cli/adapters/base-cli-adapter.types';

const logger = getLogger('HistoryRestoreCoordinator');
const DEFAULT_POLL_INTERVAL_MS = 200;

/**
 * Duck-typed accessor for adapter resume proof.
 * Returns true/false if the adapter has a definitive answer, null if still pending.
 */
function getAdapterResumeProof(instanceManager: InstanceManager, instanceId: string): boolean | null {
  // getAdapter is on InstanceManager but not on slimmer dep types — use optional call.
  const adapter = (instanceManager as unknown as { getAdapter?(id: string): unknown }).getAdapter?.(instanceId);
  if (!adapter) return null;
  const a = adapter as { getResumeAttemptResult?: () => ResumeAttemptResult | null | undefined };
  if (typeof a.getResumeAttemptResult !== 'function') return null;
  const result = a.getResumeAttemptResult();
  if (!result || result.source === 'none') return null;
  // fresh-fallback means no native resume was attempted — definitively not confirmed.
  if (result.source === 'fresh-fallback') return false;
  // A `--fork-session` resume returns a NEW id by definition, so a mismatch is
  // the success shape, not a failure (LT-008 — see ResumeAttemptResult.forked).
  if (!result.forked && result.actualSessionId && result.requestedSessionId
      && result.actualSessionId !== result.requestedSessionId) return false;
  if (result.confirmed) return true;
  if (result.reason) return false;
  return null;
}

/**
 * Outcome of the post-spawn resume probe. `disproven` separates "the adapter
 * told us the native resume did NOT happen" from "we never got proof either
 * way".
 *
 * It deliberately does NOT demote the restore to the replay rung: an
 * alive-but-unresumed instance stays on `resume-unconfirmed` by design (the
 * B1/B2 locks in `history-restore-coordinator.spec.ts`). Killing a healthy
 * process only to spawn an identical one buys nothing — the archived
 * transcript is already in its buffer and the continuity preamble is queued.
 *
 * It does drive two things a silent `resume-unconfirmed` used to skip
 * (LT-014, James's call 2026-07-27): the user-facing "could not be restored
 * natively" notice, and recording `nativeResumeFailedAt` so the next restore
 * skips the doomed native rung. A merely-unproven resume (`disproven: false`)
 * stays silent — absence of proof is not proof of absence.
 */
interface ResumeWaitState {
  alive: boolean;
  confirmed: boolean;
  disproven: boolean;
}

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
): OutputMessage {
  const providerName = getProviderDisplayName(params.restoreProvider);
  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'system',
    content: `Previous ${providerName} CLI session could not be restored natively. Your conversation history is displayed above, and a condensed transcript will be attached automatically to your next message.`,
    metadata: {
      isRestoreNotice: true,
      systemMessageKind: 'restore-fallback',
      provider: params.restoreProvider,
      restoredMessageCount: params.restoreTranscriptMessages.length,
      hiddenMessageCount: 0,
      continuityInjectionQueued,
      nativeResumeFailedAt: Date.now(),
      originalSessionId: params.nativeResumeSessionId,
      restoreNodeId: params.restoreNodeId ?? null,
    },
  };
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
    const restoreModel = data.entry.currentModel?.trim() || undefined;
    const restoreRuntimeSummary = data.entry.runtimeSummary;
    const restoreBrowserToolsMode = data.entry.browserToolsMode;
    const restoreHardened = data.entry.hardened;
    // A Copilot thread resumes under the SAME GitHub account it was created
    // with. Restoring it under the current default would send this
    // conversation's context through a different identity.
    const restoreCopilotProfileId = data.entry.copilotAccountProfileId;
    const nativeResumeSessionId = opts.forkAs || opts.forceFallback
      ? undefined
      : getNativeResumeSessionId(data.entry);
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
      const attempt = await this.tryNativeResume({
        instanceManager,
        workingDir,
        displayName,
        isRenamed: data.entry.isRenamed,
        historyThreadId,
        nativeResumeSessionId,
        restoreTranscriptMessages,
        restoreProvider,
        restoreModel,
        restoreRuntimeSummary,
        restoreBrowserToolsMode,
        restoreHardened,
        restoreCopilotProfileId,
        restoreNodeId,
      });
      if (attempt.kind === 'restored') {
        // An alive-but-disproven resume keeps its rung but still burns the
        // handle: without this, every later restore re-attempts the same
        // doomed native resume (LT-014).
        if (attempt.markResumeFailed) {
          await this.recordNativeResumeFailure(entryId);
        }
        return attempt.result;
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
    });
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
    restoreModel?: string;
    restoreRuntimeSummary?: Instance['runtimeSummary'];
    restoreBrowserToolsMode?: Instance['browserToolsMode'];
    restoreHardened?: boolean;
    restoreCopilotProfileId?: string;
    restoreNodeId?: string;
  }): Promise<NativeResumeAttempt> {
    let resumeInstanceId: string | undefined;
    const postSpawnTimeoutMs = this.postSpawnTimeoutMs ?? (params.restoreNodeId ? 15_000 : 5_000);

    try {
      const instance = await params.instanceManager.createInstance({
        workingDirectory: params.workingDir,
        displayName: params.displayName,
        isRenamed: params.isRenamed,
        isRestoredSession: true,
        historyThreadId: params.historyThreadId,
        sessionId: params.nativeResumeSessionId,
        resume: true,
        initialOutputBuffer: params.restoreTranscriptMessages,
        provider: params.restoreProvider,
        modelOverride: params.restoreModel,
        runtimeSummary: params.restoreRuntimeSummary,
        browserToolsMode: params.restoreBrowserToolsMode,
        hardened: params.restoreHardened,
      copilotAccountProfileId: params.restoreCopilotProfileId,
        forceNodeId: params.restoreNodeId,
      });
      resumeInstanceId = instance.id;
      instance.autoRespawnSuppressedUntil = Date.now() + postSpawnTimeoutMs + 2_000;

      try {
        await instance.readyPromise;
      } catch (error) {
        // Keep the underlying reason (e.g. "Timeout checking Codex CLI"): it is
        // what tells a later reader whether the session or the host failed.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Instance initialization failed during resume: ${reason}`);
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
            buildDisprovenResumeNotice(params, Boolean(preamble)),
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

      await this.cleanupFailedNativeResume(params.instanceManager, instance);
      return { kind: 'session-dead' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('History restore: native resume attempt failed', {
        resumeInstanceId,
        error: errorMessage,
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
      return { kind: 'infrastructure', error: errorMessage };
    }
  }

  private waitForResumeState(
    instanceManager: InstanceManager,
    instanceId: string,
    postSpawnTimeoutMs: number,
  ): Promise<ResumeWaitState> {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
      };
      const complete = (value: ResumeWaitState): void => {
        if (!settled) {
          cleanup();
          resolve(value);
        }
      };
      const inspect = (): ResumeWaitState => {
        const inst = instanceManager.getInstance(instanceId);
        const alive = inst != null
          && inst.status !== 'error'
          && inst.status !== 'terminated'
          && inst.status !== 'respawning';
        if (!alive) return { alive: false, confirmed: false, disproven: false };

        // Prefer adapter proof (set from init events) over context-usage heuristic.
        // A `false` here is a DEFINITIVE negative (LT-014): the adapter already
        // knows the native resume did not happen — e.g. Claude found no
        // transcript for the id under this cwd and spawned fresh. The rung is
        // unchanged (still `resume-unconfirmed`), but there is nothing left to
        // wait for, so the probe stops now rather than at the timeout.
        const proof = getAdapterResumeProof(instanceManager, instanceId);
        if (proof !== null) return { alive: true, confirmed: proof, disproven: !proof };

        // Fall back to context-usage heuristic (used > 0 means the provider resumed).
        // Absence of usage is not proof of failure — it stays merely unconfirmed.
        const confirmed = Boolean(inst.contextUsage && inst.contextUsage.used > 0);
        return { alive, confirmed, disproven: false };
      };

      const timeout = setTimeout(() => {
        complete(inspect());
      }, postSpawnTimeoutMs);

      const poll = setInterval(() => {
        const state = inspect();
        if (!state.alive || state.confirmed || state.disproven) {
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
      modelOverride: params.restoreModel,
      runtimeSummary: params.restoreRuntimeSummary,
      browserToolsMode: params.restoreBrowserToolsMode,
      hardened: params.restoreHardened,
      copilotAccountProfileId: params.restoreCopilotProfileId,
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

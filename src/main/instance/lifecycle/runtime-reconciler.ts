/**
 * RuntimeReconciler — the single owner of instance runtime changes.
 *
 * Architectural direction (agreed 2026-07-16): the conversation is the durable
 * entity the orchestrator owns; a provider/model is a replaceable runtime
 * attachment. Provider-native sessions (resume cursors, JSONL threads) are a
 * cache, never the authority. Runtime changes flow diff → continuity plan →
 * execution under one mutex.
 *
 * Provider/model swap is the first client. The existing respawn paths
 * (toggleYoloMode, interrupt-respawn, unexpected-exit, history-restore
 * fallback) migrate here one-per-change — see
 * docs/superpowers/specs/2026-07-16-runtime-reconciler-migration_spec.md.
 *
 * `applyRuntimeChange` is the extracted body of the former
 * `InstanceLifecycleManager.changeModel` (incident-hardened: fresh-fallback
 * ordering, writeThroughIdentityLocked, waitForResumeHealth), extended with
 * cross-provider swap logic. Behavior for same-provider model changes is
 * unchanged — the pre-existing changeModel unit tests run against the shim.
 */

import { getLogger } from '../../logging/logger';
import { generateId } from '../../../shared/utils/id-generator';
import { getModelSwitchUnavailableReason } from '../../../shared/types/instance-status-policy';
import { getSessionMutex } from '../../session/session-mutex';
import {
  getSessionContinuityManager,
  getSessionContinuityManagerIfInitialized,
} from '../../session/session-continuity';
import {
  getDefaultModelForCli,
  getProviderModelContextWindow,
  isModelTier,
  looksLikeCodexModelId,
  resolveModelForTier,
} from '../../../shared/types/provider.types';
import { getAgentById, getDefaultAgent } from '../../../shared/types/agent.types';
import {
  attachToolFilterMetadata,
  buildToolPermissionConfig,
} from './tool-permission-config';
import { getKnownModelsForCli } from './create-validation-helpers';
import { resolveAvailableModelSelection } from './model-selection-degradation';
import { resolveExecutionLocation } from './execution-location-resolver';
import { buildLocalModelRuntimeSummary } from './instance-create-builder';
import {
  assertSwapTargetCliAvailable,
  mapReasoningEffortForProvider,
  resolveSwapModel,
  type SwapTargetProvider,
} from './model-change-provider-swap';
import { computeRuntimeDiff, planContinuity } from './runtime-reconciler-plan';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import type {
  RecoveryRespawnHooks,
  RecoveryRespawnOutcome,
  RecoveryRespawnRequest,
  RuntimeReconcilerDeps,
} from './runtime-reconciler.types';

const logger = getLogger('RuntimeReconciler');

export { computeRuntimeDiff, planContinuity };

export class RuntimeReconciler {
  constructor(private readonly deps: RuntimeReconcilerDeps) {}

  /**
   * Apply a desired runtime to an instance while preserving conversation
   * context: session mutex, status gate, adapter terminate, respawn per the
   * continuity plan, identity persistence, notices, and state broadcast.
   */
  async applyRuntimeChange(instanceId: string, desired: DesiredRuntime): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'runtime-change');
    try {
      const unavailableReason = getModelSwitchUnavailableReason(instance.status);
      if (unavailableReason) {
        throw new Error(unavailableReason);
      }

      const oldModel = instance.currentModel || 'default';
      const oldCurrentModel = instance.currentModel;
      const oldProvider = instance.provider;
      const oldFastMode = instance.fastMode;
      const oldReasoningEffort = instance.reasoningEffort;
      const localModelTarget = desired.modelRuntimeTarget?.kind === 'local-model'
        ? desired.modelRuntimeTarget
        : null;
      const diff = computeRuntimeDiff(instance, desired);
      const isProviderSwap = diff.providerChanged;
      const targetProvider = desired.provider as SwapTargetProvider;
      const settingsAll = this.deps.getSettings();
      const nextYoloMode = desired.yoloMode === undefined ? instance.yoloMode : desired.yoloMode;
      // A change that touches ONLY the permission posture uses yolo's own
      // continuity rule (below) instead of planContinuity, which forces
      // replay for every Claude change to guarantee a *model* change actually
      // takes effect. That reasoning doesn't apply when the model isn't
      // changing — Claude native-resume is safe for a pure yolo toggle.
      const isYoloOnlyChange =
        diff.yoloModeChanged
        && !diff.providerChanged
        && !diff.modelChanged
        && !diff.reasoningChanged
        && !diff.runtimeTargetChanged;
      if (diff.yoloModeChanged && nextYoloMode) {
        logger.warn('YOLO mode enabled for instance', {
          instanceId: instance.id,
          parentId: instance.parentId,
          provider: instance.provider,
        });
      }

      let newModel = desired.model;
      if (isProviderSwap) {
        await assertSwapTargetCliAvailable(instance, targetProvider, settingsAll.defaultCli);
        newModel = resolveSwapModel(targetProvider, desired.model, settingsAll);
      } else if (newModel === undefined && !localModelTarget) {
        // Same-provider request without a model — nothing to change to.
        newModel = instance.currentModel;
      }
      let nextReasoningEffort =
        desired.reasoningEffort === undefined
          ? instance.reasoningEffort
          : desired.reasoningEffort ?? undefined;
      if (isProviderSwap) {
        nextReasoningEffort = mapReasoningEffortForProvider(targetProvider, nextReasoningEffort);
      }
      logger.info('Applying runtime change', {
        instanceId,
        oldModel,
        newModel,
        oldProvider,
        targetProvider: isProviderSwap ? targetProvider : undefined,
        oldReasoningEffort,
        nextReasoningEffort,
        adapterExists: !!this.deps.getAdapter(instanceId),
      });

      let nextExecutionLocation = instance.executionLocation;
      if (localModelTarget) {
        await this.deps.assertLocalModelRuntimeAvailable(localModelTarget);
        nextExecutionLocation = resolveExecutionLocation({
          workingDirectory: instance.workingDirectory,
          modelRuntimeTarget: localModelTarget,
        });
      }

      // Check if there's a conversation to resume
      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );

      // Terminate existing adapter
      const oldAdapter = this.deps.getAdapter(instanceId);
      const oldAdapterCapabilities = this.deps.getAdapterRuntimeCapabilities(oldAdapter);
      if (oldAdapter) {
        this.deps.deleteAdapter(instanceId);
        await oldAdapter.terminate(true);
      }

      // Update instance state
      this.deps.transitionState(instance, 'initializing');
      instance.yoloMode = nextYoloMode;

      // Resolve agent and permissions
      const agent = getAgentById(instance.agentId) || getDefaultAgent();
      const toolPermissions = buildToolPermissionConfig(agent.permissions, {
        allowedToolsPolicy: 'standard-unless-yolo',
        yoloMode: nextYoloMode,
      });
      attachToolFilterMetadata(instance, toolPermissions.toolFilter);

      if (isProviderSwap) {
        // Must happen before resolveCliTypeForInstance — the CLI type (and
        // every spawn option keyed off it: MCP config, browser-gateway MCP,
        // permission hooks) derives from instance.provider.
        instance.provider = targetProvider;
        if (instance.fastMode && targetProvider !== 'claude' && targetProvider !== 'codex') {
          logger.info('Dropping fast mode — target provider has no equivalent', {
            instanceId,
            targetProvider,
          });
          instance.fastMode = false;
        }
      }

      const cliType = await this.deps.resolveCliTypeForInstance(instance);
      const continuity = isYoloOnlyChange
        ? (hasConversation && oldAdapterCapabilities.supportsResume
            ? (oldAdapterCapabilities.supportsForkSession ? 'native-resume-fork' : 'native-resume')
            : 'replay')
        : planContinuity({
            diff,
            capabilities: oldAdapterCapabilities,
            hasConversation,
            cliType,
            isLocalModelTarget: !!localModelTarget,
          });
      const shouldResume = continuity !== 'replay';
      const shouldForkSession = continuity === 'native-resume-fork';

      // Validate model against provider before passing it
      let validatedModel: string | undefined = localModelTarget?.modelId ?? newModel;
      if (!localModelTarget && newModel !== undefined && isModelTier(newModel)) {
        validatedModel = resolveModelForTier(newModel, cliType);
      }

      // Mirrors spawn-time validation against CLI discovery + unified catalog snapshot.
      const modelToValidate = validatedModel;
      if (!localModelTarget && modelToValidate !== undefined) {
        const knownModelIds = await getKnownModelsForCli(cliType);
        const selection = resolveAvailableModelSelection({
          provider: cliType,
          requestedModel: modelToValidate,
          knownModelIds,
          fallbackModel: getDefaultModelForCli(cliType),
          allowDynamicCodexModel:
            cliType === 'codex' && looksLikeCodexModelId(modelToValidate),
        });
        if (selection.degradation) {
          logger.warn('Model not valid for target provider during runtime change, using provider default', {
            model: selection.degradation.requestedModel,
            provider: cliType,
            validModelCount: knownModelIds.length,
            fallbackModel: selection.degradation.fallbackModel ?? 'provider-default',
          });
          this.deps.emitModelSelectionDegradation(instance, selection.degradation);
        }
        validatedModel = selection.model;
      }

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : (shouldResume ? instance.sessionId : generateId());
      instance.sessionId = newSessionId;

      instance.currentModel = validatedModel;
      instance.reasoningEffort = nextReasoningEffort;
      instance.executionLocation = nextExecutionLocation;
      if (localModelTarget) {
        instance.modelRuntimeTarget = localModelTarget;
        instance.runtimeSummary = buildLocalModelRuntimeSummary(localModelTarget);
      } else {
        instance.modelRuntimeTarget = undefined;
        instance.runtimeSummary = undefined;
      }
      const contextTotal = getProviderModelContextWindow(cliType, validatedModel);
      instance.contextUsage = {
        ...instance.contextUsage,
        total: contextTotal,
        percentage: contextTotal > 0
          ? Math.min((instance.contextUsage.used / contextTotal) * 100, 100)
          : 0
      };

      const spawnConfigBuilder = this.deps.spawnConfigBuilder;
      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: newSessionId,
        workingDirectory: instance.workingDirectory,
        systemPrompt: agent.systemPrompt,
        model: validatedModel,
        yoloMode: instance.yoloMode,
        launchMode: instance.launchMode,
        bare: instance.bareMode === true,
        reasoningEffort: nextReasoningEffort,
        fastMode: instance.fastMode,
        residentClaude: this.deps.residentClaudeForSpawn(instance),
        allowedTools: toolPermissions.allowedTools,
        disallowedTools: toolPermissions.disallowedToolsForSpawn,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
        chromeDevtoolsMcp: spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
        browserGatewayMcp: spawnConfigBuilder.getBrowserGatewayMcpOptions(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        nodePlacement: instance.nodePlacement,
        permissionHookPath: spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
        rtk: spawnConfigBuilder.getRtkSpawnConfig(),
        ...(localModelTarget ? { modelRuntimeTarget: localModelTarget } : {}),
      };

      let adapter = this.deps.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        let pid: number;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.deps.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after model change');
          }
          await this.deps.waitForInputReadinessBoundary(instanceId, adapter);
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Failed to spawn with resume, falling back to fresh session', { error: spawnError instanceof Error ? spawnError.message : String(spawnError), instanceId });
            await adapter.terminate(true);

            const fallbackOptions = { ...spawnOptions, resume: false, forkSession: false, sessionId: generateId() };
            instance.sessionId = fallbackOptions.sessionId;
            adapter = this.deps.createRuntimeAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();
            try {
              await getSessionContinuityManager().writeThroughIdentityLocked(instanceId, { sessionId: fallbackOptions.sessionId, resumeCursor: null });
            } catch (err) {
              logger.warn('writeThroughIdentity failed after fresh fallback (runtime-change)', {
                instanceId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            await this.deps.waitForInputReadinessBoundary(instanceId, adapter);

            if (hasConversation) {
              this.deps.prepareStatusForAdapterInput(instance);
              await adapter.sendInput(await this.deps.buildFallbackHistory(instance, 'resume-failed-fallback'));
            }
          } else {
            throw spawnError;
          }
        }

        instance.processId = pid;
        this.deps.transitionState(instance, 'idle');
        logger.info('Runtime change applied', {
          instanceId,
          pid,
          newModel: validatedModel || 'provider-default',
          provider: instance.provider,
          reasoningEffort: nextReasoningEffort ?? 'provider-default',
          continuity,
        });

        if (isProviderSwap) {
          // The old provider's session is gone for good: persist the fresh
          // identity and null the resume cursor so no later restore attempts a
          // native resume against the old provider. The config fingerprint
          // guards this too; the explicit clear makes it durable. The tracked
          // session state must also adopt the new provider/model —
          // saveStateLocked persists the tracked snapshot, not the live
          // instance, and a restore spawns whatever CLI that snapshot names.
          instance.providerSessionId = instance.sessionId;
          try {
            await getSessionContinuityManager().updateState(instanceId, {
              provider: instance.provider,
              ...(validatedModel !== undefined ? { modelId: validatedModel } : {}),
            });
            await getSessionContinuityManager().writeThroughIdentityLocked(instanceId, {
              sessionId: instance.sessionId,
              resumeCursor: null,
            });
          } catch (err) {
            logger.warn('writeThroughIdentity failed after provider swap', {
              instanceId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (!shouldResume && hasConversation) {
          await adapter.sendInput(
            this.deps.buildReplayContinuityMessage(
              instance,
              isYoloOnlyChange ? 'yolo-toggle' : isProviderSwap ? 'provider-change' : 'model-change',
            ),
          );
        }

        if (isYoloOnlyChange) {
          // Notify the instance about the permission-posture change.
          await adapter.sendInput(
            nextYoloMode
              ? '[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]'
              : '[System: YOLO mode disabled - tool permissions will now require approval.]'
          );
        } else {
          // Notify the instance about the change
          await adapter.sendInput(
            isProviderSwap
              ? `[System: Provider changed from ${oldProvider} (model ${oldModel}) to ${instance.provider} (model ${validatedModel || 'provider default'}). Thinking changed from ${oldReasoningEffort ?? 'provider default'} to ${nextReasoningEffort ?? 'provider default'}. Conversation context has been carried over from the previous provider.]`
              : `[System: Model changed from ${oldModel} to ${validatedModel || 'provider default'}. Thinking changed from ${oldReasoningEffort ?? 'provider default'} to ${nextReasoningEffort ?? 'provider default'}. Conversation context has been preserved.]`
          );
          if (diff.yoloModeChanged) {
            // Combined change (e.g. a queued model swap and a queued yolo
            // flip both landed together) — also announce the permission change.
            await adapter.sendInput(
              nextYoloMode
                ? '[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]'
                : '[System: YOLO mode disabled - tool permissions will now require approval.]'
            );
          }
        }
      } catch (error) {
        if (isProviderSwap) {
          // Leave the instance pointed at its previous provider so a manual
          // restart relaunches the CLI that was actually running. The resume
          // cursor is only cleared after a successful swap spawn, so the old
          // session remains resumable where the provider supports it.
          instance.provider = oldProvider;
          instance.fastMode = oldFastMode;
          instance.currentModel = oldCurrentModel;
          instance.reasoningEffort = oldReasoningEffort;
        }
        this.deps.transitionState(instance, 'error');
        logger.error('Failed to apply runtime change', error instanceof Error ? error : undefined, { instanceId, newModel, targetProvider });
        throw error;
      }

      this.deps.queueUpdate(
        instanceId,
        instance.status,
        instance.contextUsage,
        undefined,
        undefined,
        undefined,
        instance.executionLocation,
        undefined,
        undefined,
        instance.currentModel,
        undefined,
        { provider: instance.provider, desiredRuntime: null },
      );
      if (!isYoloOnlyChange) {
        // A pure permission-posture flip is not a model/provider change —
        // the old toggleYoloMode never announced one either.
        this.deps.emitRuntimeChanged({
          instanceId,
          model: validatedModel ?? newModel,
          provider: instance.provider,
          reasoningEffort: nextReasoningEffort,
        });
      }
      if (diff.yoloModeChanged) {
        // Live push for the renderer's pending-yolo convenience state. This
        // also covers the deferred auto-apply path, which never goes through
        // the requestYoloModeToggle wrapper.
        this.deps.emitYoloToggled({ instanceId, yoloMode: nextYoloMode });
      }

      return instance;
    } finally {
      release();
    }
  }

  /**
   * Spec item 2: the recovery-respawn spawn core (interrupt today; the
   * unexpected-exit and history-restore paths migrate onto this in items 3/4).
   *
   * Contract: the CALLER holds the per-instance session lock (acquired with
   * its recovery metadata before breaker/abort/plan work) — asserted here so
   * misuse fails loudly instead of racing. This preserves the "reconciler is
   * the single mutex-owning executor" intent without re-entering the
   * non-reentrant SessionMutex (see the self-deadlock incident).
   *
   * Owns, in incident-hardened order: adapter create/register → abort check →
   * spawn → resume-health wait → readiness wait; on resume failure:
   * listener-strip → terminate → fresh session identity
   * (blacklist/persisted flags) → re-create → abort check → spawn →
   * `writeThroughIdentityLocked` (fresh id, null cursor, BEFORE reporting
   * complete) → readiness wait → fallback-history delivery. Success-path
   * session flags and `recoveryMethod` are set here; all interrupt-phase and
   * renderer bookkeeping stays with the orchestrator.
   */
  /**
   * Recovery resume-health policy. Keep a healthy session; destroy only a
   * proven-unrecoverable one (process dead / session-not-found / wrong session).
   * An `inconclusive` verdict — alive but unproven after the load-scaled window —
   * is retried once and then accepted, so a session that was merely slow under
   * host load is never torn down. Tearing it down is exactly what previously lost
   * the live thread and in-flight background agents on "resume failed".
   *
   * @returns true to keep the resumed session, false to fall back to a fresh one.
   */
  private async resolveRecoveryResumeHealth(instanceId: string): Promise<boolean> {
    const first = await this.deps.evaluateResumeHealth(instanceId);
    if (first === 'healthy') {
      return true;
    }
    if (first === 'unrecoverable') {
      return false;
    }
    // inconclusive — give a slow host one more window before deciding.
    const second = await this.deps.evaluateResumeHealth(instanceId);
    if (second === 'unrecoverable') {
      return false;
    }
    if (second === 'inconclusive') {
      logger.warn(
        'Recovery resume health inconclusive after retry; keeping the live session '
        + 'rather than destroying it (host may be overloaded)',
        { instanceId },
      );
    }
    return true;
  }

  async applyRecoveryRespawn(
    instanceId: string,
    request: RecoveryRespawnRequest,
    hooks: RecoveryRespawnHooks,
  ): Promise<RecoveryRespawnOutcome> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }
    if (!getSessionMutex().getLockInfo(instanceId)) {
      throw new Error(
        'applyRecoveryRespawn requires the caller to hold the session lock (recovery-entry contract)',
      );
    }

    let adapter = this.deps.createRuntimeAdapter(
      request.cliType,
      request.spawnOptions,
      instance.executionLocation,
    );
    this.deps.setupAdapterEvents(instanceId, adapter);
    this.deps.setAdapter(instanceId, adapter);

    if (hooks.shouldAbort()) {
      await hooks.onAborted(adapter, 'pre-spawn recovery respawn cancellation');
      return { status: 'aborted' };
    }

    let pid: number;
    let actuallyResumed = request.shouldResume;
    let recoveryInputSent = false;
    try {
      pid = await adapter.spawn();
      instance.processId = pid;
      if (request.shouldResume && !(await this.resolveRecoveryResumeHealth(instanceId))) {
        throw new Error('Native resume did not stabilize during recovery respawn');
      }
      instance.providerSessionId = request.postSpawnProviderSessionId;
      await hooks.waitReady(adapter);
    } catch (spawnError) {
      if (hooks.shouldAbort()) {
        await hooks.onAborted(adapter, 'recovery respawn spawn cancelled');
        return { status: 'aborted' };
      }
      if (!request.shouldResume) {
        throw spawnError;
      }

      // Resume failed (e.g. corrupted session). Fall back to a fresh session
      // with replay continuity.
      logger.warn('Resume failed during recovery respawn, falling back to fresh session', {
        instanceId,
        error: spawnError instanceof Error ? spawnError.message : String(spawnError),
      });
      // Remove listeners BEFORE terminating so the exit handler does not treat
      // the doomed resume adapter's exit as a real instance exit.
      adapter.removeAllListeners();
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await adapter.terminate(true).catch(() => {});

      const fallbackSessionId = generateId();
      instance.sessionId = fallbackSessionId;
      // Fresh session — unblock future resume attempts against the new id,
      // and block a premature re-resume until its first turn settles.
      instance.sessionResumeBlacklisted = false;
      instance.providerSessionPersisted = false;
      const fallbackOptions: UnifiedSpawnOptions = {
        ...request.spawnOptions,
        resume: false,
        forkSession: false,
        sessionId: fallbackSessionId,
      };
      adapter = this.deps.createRuntimeAdapter(
        request.cliType,
        fallbackOptions,
        instance.executionLocation,
      );
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      if (hooks.shouldAbort()) {
        await hooks.onAborted(adapter, 'pre-spawn recovery fallback cancellation');
        return { status: 'aborted' };
      }

      pid = await adapter.spawn();
      actuallyResumed = false;
      instance.processId = pid;
      instance.providerSessionId = fallbackSessionId;
      // C1/B4: Persist the fresh session ID before reporting respawn complete
      // so a crash cannot replay the old doomed session/cursor.
      try {
        await getSessionContinuityManagerIfInitialized()?.writeThroughIdentityLocked(instanceId, {
          sessionId: fallbackSessionId,
          resumeCursor: null,
        });
      } catch (err) {
        logger.warn('writeThroughIdentity failed after recovery fresh fallback', {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await hooks.waitReady(adapter);

      if (request.hasConversation) {
        recoveryInputSent = await hooks.deliverContinuity(
          adapter,
          await this.deps.buildFallbackHistory(instance, request.fallbackReason),
        );
      }
    }

    if (hooks.shouldAbort()) {
      await hooks.onAborted(adapter, 'post-spawn recovery respawn cancellation');
      return { status: 'aborted' };
    }

    instance.recoveryMethod = actuallyResumed
      ? 'native'
      : (request.hasConversation ? 'replay' : 'fresh');
    if (actuallyResumed) {
      // Clear any stale blacklist — resume just succeeded against this id —
      // and record that the provider session is demonstrably on disk.
      instance.sessionResumeBlacklisted = false;
      instance.providerSessionPersisted = true;
    }
    instance.processId = pid;

    if (!actuallyResumed && request.shouldResume) {
      // Continuity already delivered in the fallback path above.
    } else if (!request.shouldResume && request.hasConversation) {
      recoveryInputSent = await hooks.deliverContinuity(
        adapter,
        this.deps.buildReplayContinuityMessage(instance, request.replayReason),
      );
    }

    logger.info('Recovery respawn complete', { instanceId, pid, resumed: actuallyResumed });
    return {
      status: 'ok',
      pid,
      adapter,
      actuallyResumed,
      recoveryInputSent,
      sessionId: instance.sessionId,
    };
  }
}

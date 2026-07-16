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
import { getSessionContinuityManager } from '../../session/session-continuity';
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
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';

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

      // Resolve agent and permissions (same as toggleYoloMode)
      const agent = getAgentById(instance.agentId) || getDefaultAgent();
      const toolPermissions = buildToolPermissionConfig(agent.permissions, {
        allowedToolsPolicy: 'standard-unless-yolo',
        yoloMode: instance.yoloMode,
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
      const continuity = planContinuity({
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
            this.deps.buildReplayContinuityMessage(instance, isProviderSwap ? 'provider-change' : 'model-change'),
          );
        }

        // Notify the instance about the change
        await adapter.sendInput(
          isProviderSwap
            ? `[System: Provider changed from ${oldProvider} (model ${oldModel}) to ${instance.provider} (model ${validatedModel || 'provider default'}). Thinking changed from ${oldReasoningEffort ?? 'provider default'} to ${nextReasoningEffort ?? 'provider default'}. Conversation context has been carried over from the previous provider.]`
            : `[System: Model changed from ${oldModel} to ${validatedModel || 'provider default'}. Thinking changed from ${oldReasoningEffort ?? 'provider default'} to ${nextReasoningEffort ?? 'provider default'}. Conversation context has been preserved.]`
        );
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
      this.deps.emitRuntimeChanged({
        instanceId,
        model: validatedModel ?? newModel,
        provider: instance.provider,
        reasoningEffort: nextReasoningEffort,
      });

      return instance;
    } finally {
      release();
    }
  }
}

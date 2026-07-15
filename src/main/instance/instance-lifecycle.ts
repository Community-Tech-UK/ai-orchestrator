/**
 * Instance Lifecycle Manager - Create, terminate, restart, and mode management
 */

import { EventEmitter } from 'events';
import {
  resolveCliType,
  getCliDisplayName,
  type UnifiedSpawnOptions,
  type CliAdapter
} from '../cli/adapters/adapter-factory';
import type { CliType } from '../cli/cli-detection';
import type { ResumeAttemptResult } from '../cli/adapters/base-cli-adapter';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import {
  getDefaultModelForCli,
  getProviderModelContextWindow,
  isModelTier,
  looksLikeCodexModelId,
  resolveModelForTier
} from '../../shared/types/provider.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { getHistoryManager } from '../history';
import { getOutputStorageManager } from '../memory';
import { getProjectMemoryBriefService } from '../memory/project-memory-brief';
import { getContextWorkerClient } from './context-worker-client';
import { extractAuthoredLessons } from '../memory/project-story-convention';
import { getProjectKnowledgeCoordinator } from '../memory/project-knowledge-coordinator';
import { getConversationMiner } from '../memory/conversation-miner';
import { getSupervisorTree } from '../process';
import { getDefaultAgent, getAgentById } from '../../shared/types/agent.types';
import { getAgentRegistry } from '../agents/agent-registry';
import { getPermissionManager } from '../security/permission-manager';
import { generateId } from '../../shared/utils/id-generator';
import type {
  Instance,
  InstanceCreateConfig,
  InstanceStatus,
  OutputMessage,
} from '../../shared/types/instance.types';
import { getModelSwitchUnavailableReason } from '../../shared/types/instance-status-policy';
import { createPromptHistoryEntryId } from '../../shared/types/prompt-history.types';
import { getLogger } from '../logging/logger';
import { resolveInstructionStack } from '../core/config/instruction-resolver';
import { getHibernationManager } from '../process/hibernation-manager';
import { getSessionContinuityManager } from '../session/session-continuity';
import { getSessionMutex } from '../session/session-mutex';
import { RecoveryRecipeEngine } from '../session/recovery-recipe-engine';
import { createBuiltinRecipes } from '../session/builtin-recovery-recipes';
import { getCheckpointManager } from '../session/checkpoint-manager';
import type { DetectedFailure } from '../../shared/types/error-recovery.types';
import { SessionDiffTracker } from './session-diff-tracker';
import {
  IllegalTransitionError,
  InstanceStateMachine,
} from './instance-state-machine';
import { getAutoTitleService } from './auto-title-service';
import { ActivityStateDetector } from '../providers/activity-state-detector';
import { getDeferDecisionStore } from '../cli/hooks/defer-decision-store';
import { InstanceSpawner } from './lifecycle/instance-spawner';
import { createSpawnTransaction, type SpawnTransaction } from './lifecycle/spawn-transaction';
import { DeferredPermissionHandler } from './lifecycle/deferred-permission-handler';
import {
  buildInstanceRecord,
  buildLocalModelRuntimeSummary,
} from './lifecycle/instance-create-builder';
import { resolveInitialModel } from './lifecycle/resolve-initial-model';
import { createModelSelectionDegradationNotice, resolveAvailableModelSelection, type ModelSelectionDegradation } from './lifecycle/model-selection-degradation';
import { resolveFastMode } from './lifecycle/resolve-fast-mode';
import { YoloModeQueue } from './lifecycle/yolo-mode-queue';
import {
  applyOutputStyle,
  applyResolvedOutputStyle,
  isOutputStyleInjectableProvider,
  isOutputStyleName,
} from './output-style';
import { getOutputStyleRegistry } from './output-style-registry';
import { PlanModeManager } from './lifecycle/plan-mode-manager';
import { RestartPolicyHelpers } from './lifecycle/restart-policy-helpers';
import {
  SessionRecoveryCoordinator,
  planSessionRecovery,
  computeResumeConfigFingerprint,
  type RecoveryResult,
} from './lifecycle/session-recovery';
import { IdleMonitor } from './lifecycle/idle-monitor';
import { InterruptRespawnHandler } from './lifecycle/interrupt-respawn-handler';
import { RuntimeReadinessCoordinator } from './lifecycle/runtime-readiness';
import { shouldPreWarmReplacement } from './lifecycle/warm-start-policy';
import { InstanceTerminationCoordinator } from './lifecycle/instance-termination';
import { SpawnConfigBuilder } from './lifecycle/spawn-config-builder';
import { createInitialUserMessage, getSeededInitialUserMessage } from './lifecycle/initial-user-message';
import { getCompactionCoordinator } from '../context/compaction-coordinator';
import { getCodemem } from '../codemem';
import { getMcpManager } from '../mcp/mcp-manager';
import { getIndexedCodebaseContextService } from '../indexing/indexed-codebase-context';
import { recordLifecycleTrace } from '../observability/lifecycle-trace';
import { warmCodememWithTimeout } from './warm-codemem';
import {
  buildUnsupportedAttachmentWarnings,
  isUnsupportedOrchestratorAttachmentError,
} from './orchestrator-attachment-fallback';
import { isOrchestratorPausedError } from '../pause/orchestrator-paused-error';
import {
  attachToolFilterMetadata,
  buildToolPermissionConfig,
} from './lifecycle/tool-permission-config';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { getPromptHistoryService } from '../prompt-history/prompt-history-service';
import { summarizeCreateInstanceConfig } from './lifecycle/instance-create-logging';
import { callWithDeadline } from '../util/deadline';
import { LifecycleMemoryPressureMonitor } from './lifecycle/memory-pressure-monitor';
import { getOrCreateTurnSupervisor } from '../session/session-turn-supervisor';
import { getKnownModelsForCli, isRestoreOrReplayContinuity, requiresFreshConfiguredModelSpawn } from './lifecycle/create-validation-helpers';
import type { McpRuntimeToolContextSelection } from '../mcp/mcp-runtime-tool-context';
import { resolveExecutionLocation } from './lifecycle/execution-location-resolver';
import { applyProviderSessionDurability } from './lifecycle/provider-session-durability';
import { getLocalModelInventoryService } from '../local-models/local-model-inventory-service';
import { buildToolPermissionPrompt } from './lifecycle/tool-permission-prompt';
import type {
  LocalModelInventoryEntry,
  ModelRuntimeTarget,
} from '../../shared/types/local-model-runtime.types';

const logger = getLogger('InstanceLifecycle');

function localModelInventoryEntryMatchesTarget(
  entry: LocalModelInventoryEntry,
  target: Extract<ModelRuntimeTarget, { kind: 'local-model' }>,
): boolean {
  return entry.source === target.source
    && entry.endpointProvider === target.endpointProvider
    && entry.endpointId === target.endpointId
    && entry.modelId === target.modelId
    && (target.source !== 'worker-node' || entry.nodeId === target.nodeId);
}

/**
 * How long create-time prompt enrichers (observation memory, MCP tool context)
 * may run before we assemble the system prompt without them. A genuinely-async
 * enricher that exceeds this is not waited on; its result, if it eventually
 * arrives, is deferred into the next turn as a continuity preamble rather than
 * blocking the first send. (Synchronous enrichers can't be interrupted by a
 * deadline — those need an off-thread move, tracked separately.)
 */
const CREATE_ENRICHER_DEADLINE_MS = 600;

export type { LifecycleDependencies } from './instance-lifecycle.types';

import type { LifecycleDependencies } from './instance-lifecycle.types';
export class InstanceLifecycleManager extends EventEmitter {
  private settings = getSettingsManager();
  private outputStorage = getOutputStorageManager();
  private deps: LifecycleDependencies;
  private activityDetectors = new Map<string, ActivityStateDetector>();
  private recoveryEngine: RecoveryRecipeEngine | null = null;
  /** Queue-aware YOLO toggling (park-while-busy + auto-apply-on-idle). */
  private _yoloQueue?: YoloModeQueue;
  /**
   * Create-time enrichers (per instance → label → section text) that missed the
   * deadline and are being deferred into the next turn's continuity preamble.
   * Accumulated so multiple late enrichers combine into one preamble.
   */
  private readonly lateEnricherPreambles = new Map<string, Map<string, string>>();

  /** Extracted runtime readiness / native-resume health checks. */
  private readonly runtimeReadiness: RuntimeReadinessCoordinator;

  /** Extracted termination and cleanup coordinator. */
  private readonly terminator: InstanceTerminationCoordinator;

  /** Extracted idle-monitoring loop (periodic activity poll + zombie cleanup). */
  private readonly idleMonitor: IdleMonitor;

  /** Extracted interrupt + post-interrupt/unexpected-exit respawn flows. */
  private readonly interruptRespawn: InterruptRespawnHandler;

  /** Extracted memory-pressure listener and stats bridge. */
  private readonly memoryPressureMonitor: LifecycleMemoryPressureMonitor;

  /**
   * Focused spawner for isolated CLI process spawn operations (e.g. test harnesses,
   * future simplified spawn flows). The existing createInstance() method handles
   * the full production lifecycle and is not delegated here.
   */
  readonly spawner: InstanceSpawner;

  /** Extracted plan-mode state machine. */
  readonly planMode: PlanModeManager;

  /** Extracted deferred-permission resume flow. */
  private readonly deferredPermission: DeferredPermissionHandler;

  /** Extracted restart/respawn policy helpers. */
  readonly restartHelpers: RestartPolicyHelpers;

  /** Extracted MCP/permission/RTK hook config builder for spawn options. */
  private readonly spawnConfigBuilder: SpawnConfigBuilder;

  private getRecoveryEngine(): RecoveryRecipeEngine {
    if (!this.recoveryEngine) {
      this.recoveryEngine = new RecoveryRecipeEngine(
        getCheckpointManager(),
        getSessionContinuityManager(),
      );
      for (const recipe of createBuiltinRecipes()) {
        this.recoveryEngine.registerRecipe(recipe);
      }
    }
    return this.recoveryEngine;
  }

  private async warmCodememWorkspace(workspacePath: string): Promise<void> {
    // Hard cap the time we're willing to block the spawn critical path on
    // codemem warm-up. On large workspaces or when the main process event
    // loop is already saturated (e.g. several restored instances streaming
    // output in parallel after a history restore), `warmWorkspace` can take
    // arbitrarily long. Previously this could delay `adapter.spawn()` by
    // minutes. Cap it: whatever hasn't finished in time just continues in
    // the background without blocking the spawn.
    await warmCodememWithTimeout(getCodemem(), {
      workspacePath,
      timeoutMs: 2500,
      logger,
    });
  }

  private async assertLocalModelRuntimeAvailable(target: InstanceCreateConfig['modelRuntimeTarget']): Promise<void> {
    if (target?.kind !== 'local-model') {
      return;
    }

    const inventoryService = getLocalModelInventoryService();
    const inventory = await inventoryService.refresh();
    const entry = inventory.find((candidate) => candidate.selectorId === target.selectorId)
      ?? inventory.find((candidate) => localModelInventoryEntryMatchesTarget(candidate, target));
    if (entry?.healthy && localModelInventoryEntryMatchesTarget(entry, target)) {
      return;
    }

    const locationLabel = target.source === 'this-device'
      ? 'this device'
      : entry?.nodeName ?? target.nodeName ?? target.nodeId ?? 'that worker';
    const endpointLocation = target.source === 'this-device' ? 'this device' : 'that worker';
    throw new Error(
      `${target.modelId} is no longer available on ${locationLabel}. ` +
      `Pick another model or start the endpoint on ${endpointLocation}.`,
    );
  }

  constructor(deps: LifecycleDependencies) {
    super();
    this.deps = deps;
    this.spawnConfigBuilder = new SpawnConfigBuilder({ settings: this.settings });
    this.runtimeReadiness = new RuntimeReadinessCoordinator({
      getInstance: (id) => deps.getInstance(id),
      getAdapter: (id) => deps.getAdapter(id),
    });
    this.terminator = new InstanceTerminationCoordinator({
      getAdapter: (id) => deps.getAdapter(id),
      getInstance: (id) => deps.getInstance(id),
      deleteAdapter: (id) => deps.deleteAdapter(id),
      deleteInstance: (id) => deps.deleteInstance(id),
      stopStuckTracking: deps.stopStuckTracking,
      deleteDiffTracker: deps.deleteDiffTracker,
      deleteStateMachine: deps.deleteStateMachine,
      forceReleaseSessionMutex: (id) => getSessionMutex().forceRelease(id),
      removeActivityDetector: (id) => {
        this.activityDetectors.delete(id);
        this.lateEnricherPreambles.delete(id);
      },
      clearRecoveryHistory: (id) => {
        this.recoveryEngine?.clearHistory(id);
      },
      transitionState: (instance, status) => this.transitionState(instance, status),
      setWaitReason: (id, waitReason) => {
        const inst = deps.getInstance(id);
        if (inst) {
          deps.queueUpdate(id, inst.status, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, waitReason);
        }
      },
      terminateChild: (id, graceful) => this.terminateInstance(id, graceful),
      unregisterSupervisor: (id) => getSupervisorTree().unregisterInstance(id),
      unregisterOrchestration: (id) => deps.unregisterOrchestration(id),
      clearFirstMessageTracking: (id) => deps.clearFirstMessageTracking(id),
      endRlmSession: (id) => deps.endRlmSession(id),
      deleteOutputStorage: (id) => this.outputStorage.deleteInstance(id),
      archiveInstance: (instance, status) => getHistoryManager().archiveInstance(instance, status),
      importTranscript: (transcript, options) => {
        getConversationMiner().importFromString(transcript, options);
      },
      emitRemoved: (id) => {
        this.emit('removed', id);
      },
    });
    this.spawner = new InstanceSpawner({
      createAdapter: async (config) => {
        const adapter = this.createRuntimeAdapter(config.provider as CliType, {
          sessionId: config.sessionId,
          workingDirectory: config.workingDirectory,
          model: config.model,
          yoloMode: config.yoloMode,
        });
        return adapter as unknown as import('./lifecycle/instance-spawner').CliAdapter;
      },
    });
    this.planMode = new PlanModeManager(
      { getInstance: deps.getInstance },
      this,
    );
    this.deferredPermission = new DeferredPermissionHandler(
      {
        getInstance: deps.getInstance,
        getAdapter: deps.getAdapter,
        setAdapter: deps.setAdapter,
        deleteAdapter: deps.deleteAdapter,
        deleteDiffTracker: deps.deleteDiffTracker,
        setDiffTracker: deps.setDiffTracker as ((id: string, tracker: unknown) => void) | undefined,
        setupAdapterEvents: deps.setupAdapterEvents,
        queueUpdate: deps.queueUpdate,
      },
      {
        transitionState: (instance, newState) => this.transitionState(instance, newState),
        resolveCliTypeForInstance: (instance) => this.resolveCliTypeForInstance(instance) as Promise<string>,
        getMcpConfig: (loc, instanceId, provider) => this.spawnConfigBuilder.getMcpConfig(loc, instanceId, provider),
        getBrowserGatewayMcpOptions: (loc, instanceId, provider) =>
          this.spawnConfigBuilder.getBrowserGatewayMcpOptions(loc, instanceId, provider),
        getChromeDevtoolsMcpOptions: (loc) => this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(loc),
        getPermissionHookPath: (yolo) => this.spawnConfigBuilder.getPermissionHookPath(yolo),
        waitForResumeHealth: (id) => this.waitForResumeHealth(id),
        createCliAdapter: (cliType, options, loc) => this.createRuntimeAdapter(cliType as CliType, options, loc),
        acquireSessionMutex: (id, label) => {
          const lockInstance = this.deps.getInstance(id);
          return getSessionMutex().acquire(id, label, {
            operation: label,
            recoveryReason: 'deferred-permission',
            turnId: lockInstance?.activeTurnId,
            adapterGeneration: lockInstance?.adapterGeneration,
          });
        },
      },
      {
        writeDecision: (toolUseId, decision, reason, updatedInput) =>
          getDeferDecisionStore().writeDecision(toolUseId, decision, reason, updatedInput),
        getDecisionDir: () => getDeferDecisionStore().getDecisionDir(),
        createDiffTracker: (workDir) => new SessionDiffTracker(workDir),
      },
    );
    this.restartHelpers = new RestartPolicyHelpers(
      {
        loadMessages: (id) => getOutputStorageManager().loadMessages(id),
        archiveInstance: (inst, status) => getHistoryManager().archiveInstance(inst, status),
        resetBudgetTracker: (id) => getCompactionCoordinator().resetBudgetTracker(id),
        clearFirstMessageTracking: (id) => deps.clearFirstMessageTracking(id),
        deleteDiffTracker: deps.deleteDiffTracker,
        setDiffTracker: deps.setDiffTracker
          ? (id, workDir) => deps.setDiffTracker!(id, new SessionDiffTracker(workDir))
          : undefined,
      },
      { getActiveMessages: (input) => this.getActiveMessages(input) },
    );
    this.idleMonitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: this.settings.getAll().autoTerminateIdleMinutes }),
      getRecoveryEngine: () => this.getRecoveryEngine(),
      getActivityDetectors: () => this.activityDetectors,
      getInstance: (id) => this.deps.getInstance(id),
      forEachInstance: (cb) => this.deps.forEachInstance(cb),
      getAdapter: (id) => this.deps.getAdapter(id),
      queueUpdate: (instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState, currentModel, waitReason) =>
        this.deps.queueUpdate(instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState, currentModel, waitReason),
      deleteAdapter: (id) => { this.deps.deleteAdapter(id); },
      transitionState: (instance, newState) => this.transitionState(instance, newState),
      terminateInstance: (id, auto) => this.terminateInstance(id, auto),
      hibernateInstance: (id) => this.hibernateInstance(id),
      dispatchRecovery: (instanceId, failure) => this.dispatchRecoveryActions(instanceId, failure),
    });
    this.idleMonitor.start();
    this.interruptRespawn = new InterruptRespawnHandler({
      getInstance: (id) => this.deps.getInstance(id),
      getAdapter: (id) => this.deps.getAdapter(id),
      setAdapter: (id, adapter) => this.deps.setAdapter(id, adapter),
      deleteAdapter: (id) => { this.deps.deleteAdapter(id); },
      queueUpdate: (instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState, currentModel, waitReason) =>
        this.deps.queueUpdate(instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState, currentModel, waitReason),
      markInterrupted: (id) => this.deps.markInterrupted(id),
      clearInterrupted: (id) => this.deps.clearInterrupted(id),
      addToOutputBuffer: (instance, message) => this.deps.addToOutputBuffer(instance, message),
      setupAdapterEvents: (id, adapter) => this.deps.setupAdapterEvents(id, adapter),
      transitionState: (instance, newState) => this.transitionState(instance, newState),
      getAdapterRuntimeCapabilities: (adapter) => this.getAdapterRuntimeCapabilities(adapter),
      resolveCliTypeForInstance: (instance) => this.resolveCliTypeForInstance(instance),
      getMcpConfig: (loc, instanceId, provider) => this.spawnConfigBuilder.getMcpConfig(loc, instanceId, provider),
      getHarnessCliEnv: (loc, instanceId, baseEnv) => this.spawnConfigBuilder.getHarnessCliEnv(loc, instanceId, baseEnv),
      getBrowserGatewayMcpOptions: (loc, instanceId, provider) =>
        this.spawnConfigBuilder.getBrowserGatewayMcpOptions(loc, instanceId, provider),
      getChromeDevtoolsMcpOptions: (loc) => this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(loc),
      getPermissionHookPath: (yolo) => this.spawnConfigBuilder.getPermissionHookPath(yolo),
      waitForResumeHealth: (id, timeoutMs) => this.waitForResumeHealth(id, timeoutMs),
      waitForAdapterWritable: (id, timeoutMs) => this.waitForAdapterWritable(id, timeoutMs),
      buildReplayContinuityMessage: (instance, reason) => this.buildReplayContinuityMessage(instance, reason),
      buildFallbackHistory: (instance, reason) => this.buildFallbackHistory(instance, reason),
      queueContinuityPreamble: (id, preamble) => this.deps.queueContinuityPreamble?.(id, preamble),
      emitOutput: (instanceId, message) => { this.emit('output', { instanceId, message }); },
      emitDisplayMarker: (instance, message) => {
        this.deps.addToOutputBuffer(instance, message);
        this.emit('output', { instanceId: instance.id, message });
      },
    });
    this.memoryPressureMonitor = new LifecycleMemoryPressureMonitor({
      settings: this.settings,
      outputStorage: this.outputStorage,
      idleMonitor: this.idleMonitor,
      warmStartManager: deps.warmStartManager,
      emit: (eventName, stats) => { this.emit(eventName, stats); },
    });
    this.memoryPressureMonitor.start();
  }

  // ============================================
  // State Machine Integration
  // ============================================

  /**
   * Public wrapper for transitionState — used by InstanceManager.updateInstanceStatus().
   *
   * The lifecycle state machine is authoritative. Illegal transitions fail
   * fast instead of mutating state behind the state machine's back.
   */
  transitionStatePublic(instance: Instance, newState: InstanceStatus): void {
    this.transitionState(instance, newState);
  }

  private transitionState(instance: Instance, newState: InstanceStatus): void {
    const previousStatus = instance.status;
    if (previousStatus === newState) {
      return;
    }

    let sm = this.deps.getStateMachine?.(instance.id);
    if (!sm) {
      sm = new InstanceStateMachine(previousStatus);
      this.deps.setStateMachine?.(instance.id, sm);
    }

    try {
      sm.transition(newState);
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        logger.error('Illegal lifecycle transition blocked', undefined, {
          instanceId: instance.id,
          from: previousStatus,
          to: newState,
        });
      }
      throw error;
    }

    instance.status = sm.current;
    recordLifecycleTrace({
      instanceId: instance.id,
      turnId: instance.activeTurnId,
      adapterGeneration: instance.adapterGeneration,
      provider: instance.provider,
      eventType: 'status-transition',
      previousStatus,
      status: instance.status,
      metadata: {
        interruptRequestId: instance.interruptRequestId,
        interruptPhase: instance.interruptPhase,
        recoveryMethod: instance.recoveryMethod,
      },
    });
    this.emit('state-update', {
      instanceId: instance.id,
      status: instance.status,
      previousStatus,
      timestamp: Date.now(),
    });

    // Auto-apply a YOLO toggle that was queued while the instance was busy.
    this.yoloQueue.onSettled(instance);
  }

  /** Lazily built so it can close over deps/setYoloMode/emit after construction. */
  private get yoloQueue(): YoloModeQueue {
    return (this._yoloQueue ??= new YoloModeQueue({
      getInstance: (id) => this.deps.getInstance(id),
      setYoloMode: (id, desired) => this.setYoloMode(id, desired),
      queueUpdate: (id, status, contextUsage) => this.deps.queueUpdate(id, status, contextUsage),
      emitYoloToggled: (payload) => {
        this.emit('yolo-toggled', payload);
      },
    }));
  }

  private resetTerminalStateForRestart(instance: Instance): void {
    if (instance.status !== 'terminated' && instance.status !== 'failed') {
      return;
    }

    const previousStatus = instance.status;
    const sm = this.deps.getStateMachine?.(instance.id) ?? new InstanceStateMachine(previousStatus);
    sm.reset('idle');
    this.deps.setStateMachine?.(instance.id, sm);
    instance.status = 'idle';
    logger.info('Reset terminal lifecycle state for same-instance restart', {
      instanceId: instance.id,
      previousStatus,
    });
  }

  private getAdapterRuntimeCapabilities(adapter?: CliAdapter) {
    return this.runtimeReadiness.getAdapterRuntimeCapabilities(adapter);
  }

  private residentClaudeForSpawn(instance: Instance): boolean {
    if (instance.residentClaude !== true) {
      instance.residentClaude = true;
    }
    return true;
  }

  private async resolveCliTypeForInstance(instance: Instance): Promise<CliType> {
    const settingsAll = this.settings.getAll();
    return resolveCliType(instance.provider, settingsAll.defaultCli);
  }

  private createRuntimeAdapter(
    cliType: CliType,
    options: UnifiedSpawnOptions,
    executionLocation?: ExecutionLocation,
  ): CliAdapter {
    const instance = options.instanceId ? this.deps.getInstance(options.instanceId) : undefined;
    const harnessCliEnv = this.spawnConfigBuilder.getHarnessCliEnv(
      executionLocation,
      options.instanceId,
      options.env,
    );
    const durableOptions = applyProviderSessionDurability(cliType, instance, {
      ...options,
      ...(harnessCliEnv ? { env: harnessCliEnv } : {}),
    });
    return getProviderRuntimeService().createAdapter({ cliType, options: durableOptions, executionLocation });
  }

  private addAdapterRollback(transaction: SpawnTransaction, instanceId: string, adapter: CliAdapter): void {
    transaction.addRollback('adapter-registration', async () => {
      (adapter as { removeAllListeners?: () => void }).removeAllListeners?.();
      if (this.deps.getAdapter(instanceId) === adapter) this.deps.deleteAdapter(instanceId);
      this.deps.deleteDiffTracker?.(instanceId);
      this.activityDetectors.delete(instanceId);
      await adapter.terminate(false).catch(() => { /* rollback continues after adapter cleanup errors */ });
    });
  }

  async refreshAdapterRuntimeConfig(instanceId: string): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    const adapter = this.deps.getAdapter(instanceId);
    if (!instance || !adapter) {
      return;
    }
    const maybeMcpConfigurable = adapter as {
      updateMcpConfig?: (mcpConfig: string[]) => void;
    };
    if (typeof maybeMcpConfigurable.updateMcpConfig !== 'function') {
      return;
    }
    const cliType = await this.resolveCliTypeForInstance(instance);
    maybeMcpConfigurable.updateMcpConfig(
      this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
    );
  }

  private isSessionBoundaryMessage(message: OutputMessage): boolean {
    return (
      message.type === 'system'
      && typeof message.metadata?.['kind'] === 'string'
      && message.metadata['kind'] === 'session-boundary'
    );
  }

  private getActiveMessages(input: Pick<Instance, 'outputBuffer' | 'archivedUpToMessageId'>): OutputMessage[] {
    const boundaryId = input.archivedUpToMessageId;
    const boundaryIndex = boundaryId
      ? input.outputBuffer.findIndex((message) => message.id === boundaryId)
      : -1;
    const candidateMessages = boundaryIndex >= 0
      ? input.outputBuffer.slice(boundaryIndex + 1)
      : input.outputBuffer;

    return candidateMessages.filter((message) => !this.isSessionBoundaryMessage(message));
  }

  private hasActiveConversation(instance: Pick<Instance, 'outputBuffer' | 'archivedUpToMessageId'>): boolean {
    return this.getActiveMessages(instance).some(
      (message) => message.type === 'user' || message.type === 'assistant'
    );
  }

  private buildReplayContinuityMessage(instance: Instance, reason: string): string {
    return this.restartHelpers.buildReplayContinuityMessage(instance, reason);
  }

  /**
   * Fire-and-forget auto-title generation from the first user message.
   */
  private triggerAutoTitle(instance: Instance, message: string, attachmentNames?: readonly string[]): void {
    getAutoTitleService().maybeGenerateTitle(
      instance.id,
      message,
      (id, title, source) => {
        logger.debug('Auto-title callback (lifecycle)', { id, title, source, isRenamed: instance.isRenamed });
        if (!instance.isRenamed) {
          instance.displayName = title;
          if (source === 'ai') {
            instance.aiTitle = title;
          }
          this.deps.queueUpdate(id, instance.status, instance.contextUsage, undefined, title);
          getSessionContinuityManager().updateState(id, { displayName: title });
        }
      },
      instance.isRenamed,
      attachmentNames,
    ).catch(() => { /* non-critical */ });
  }

  private async buildFallbackHistory(instance: Instance, reason: string): Promise<string> {
    return this.restartHelpers.buildFallbackHistory(instance, reason);
  }

  private emitAttachmentDropWarnings(
    instanceId: string,
    instance: Instance,
    adapterName: string,
    attachments: NonNullable<InstanceCreateConfig['attachments']>,
  ): void {
    const warnings = buildUnsupportedAttachmentWarnings(adapterName, attachments);
    for (const warning of warnings) {
      this.deps.addToOutputBuffer(instance, warning);
      this.emit('output', { instanceId, message: warning });
    }
  }

  private queuePausedInitialPrompt(params: {
    instance: Instance;
    message: string;
    attachments?: InstanceCreateConfig['attachments'];
  }): void {
    const { instance, message, attachments } = params;
    this.deps.queueInitialPromptForRenderer?.({
      instanceId: instance.id,
      message,
      attachments,
      seededAlready: true,
    });

    const notice: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: 'Initial prompt queued while the orchestrator is paused. It will be sent when pause is lifted.',
      metadata: {
        source: 'pause-on-vpn',
        queuedInitialPrompt: true,
      },
    };
    this.deps.addToOutputBuffer(instance, notice);
    this.emit('output', { instanceId: instance.id, message: notice });
  }

  private emitModelSelectionDegradation(instance: Instance, degradation: ModelSelectionDegradation): void {
    const notice = createModelSelectionDegradationNotice(degradation);
    this.deps.addToOutputBuffer(instance, notice);
    this.emit('output', { instanceId: instance.id, message: notice });
  }

  private async sendInitialPromptWithAttachmentFallback(params: {
    instance: Instance;
    adapter: CliAdapter;
    resolvedCliType: CliType;
    message: string;
    contextBlock?: string;
    attachments?: InstanceCreateConfig['attachments'];
  }): Promise<void> {
    const { instance, adapter, resolvedCliType, message } = params;
    const runtimeMessage = params.contextBlock?.trim()
      ? `${params.contextBlock}\n\n${message}`
      : message;
    let attachments = params.attachments;

    try {
      await adapter.sendInput(runtimeMessage, attachments);
      return;
    } catch (initialError) {
      if (isOrchestratorPausedError(initialError)) {
        this.queuePausedInitialPrompt({ instance, message: runtimeMessage, attachments });
        return;
      }

      if (!attachments?.length || !isUnsupportedOrchestratorAttachmentError(initialError)) {
        throw initialError;
      }

      this.emitAttachmentDropWarnings(instance.id, instance, adapter.getName(), attachments);

      if (!runtimeMessage.trim()) {
        logger.info('Dropped unsupported attachments from attachment-only initial prompt', {
          instanceId: instance.id,
          provider: resolvedCliType,
        });
        return;
      }

      attachments = undefined;
      try {
        await adapter.sendInput(runtimeMessage, attachments);
      } catch (retryError) {
        if (isOrchestratorPausedError(retryError)) {
          this.queuePausedInitialPrompt({ instance, message: runtimeMessage, attachments });
          return;
        }
        throw retryError;
      }
    }
  }

  /**
   * Queue a create-time enricher that exceeded its deadline into the next turn's
   * continuity preamble instead of dropping it. Multiple late enrichers for the
   * same instance are combined into one preamble (the continuity slot holds a
   * single string). No-op for empty text or when no preamble sink is wired.
   */
  private deferEnricherPreamble(instanceId: string, label: string, text: string | null): void {
    if (!text || !text.trim() || !this.deps.queueContinuityPreamble) {
      return;
    }
    let byLabel = this.lateEnricherPreambles.get(instanceId);
    if (!byLabel) {
      byLabel = new Map<string, string>();
      this.lateEnricherPreambles.set(instanceId, byLabel);
    }
    byLabel.set(label, text.trim());
    const combined = [...byLabel.values()].join('\n\n---\n\n');
    this.deps.queueContinuityPreamble(instanceId, combined);
    logger.info('Deferred create-time enricher to next turn', { instanceId, label });
  }

  private async buildInitialRuntimeContextBlock(
    instance: Instance,
    config: InstanceCreateConfig,
    initialPrompt: string | undefined,
  ): Promise<string | undefined> {
    const blocks = [config.initialContextBlock?.trim()].filter(Boolean) as string[];
    const prompt = initialPrompt?.trim();
    if (!prompt || instance.depth !== 0 || isRestoreOrReplayContinuity(config)) {
      return blocks.length > 0 ? blocks.join('\n\n') : undefined;
    }

    try {
      const service = getIndexedCodebaseContextService();
      const indexedContext = await service.buildContext({
        workspacePath: instance.workingDirectory,
        query: prompt,
        maxTokens: 900,
        topK: 5,
      });
      const indexedBlock = service.formatContextBlock(indexedContext);
      if (indexedBlock) {
        blocks.push(indexedBlock);
        logger.info('Injected indexed codebase context into initial prompt', {
          instanceId: instance.id,
          storeId: indexedContext?.storeId,
          resultCount: indexedContext?.results.length ?? 0,
          tokens: indexedContext?.tokens ?? 0,
        });
      }
    } catch (error) {
      logger.warn('Failed to build indexed codebase context for initial prompt', {
        instanceId: instance.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return blocks.length > 0 ? blocks.join('\n\n') : undefined;
  }

  private async waitForResumeHealth(
    instanceId: string,
    timeoutMs = 5000,
    pollIntervalMs = 200,
  ): Promise<boolean> {
    // §4.G/B-series: proving a native resume can take seconds. Surface a
    // `resume-proof` waitReason for the duration so the user sees why the
    // session is "thinking" before it accepts input — but only when there is a
    // session id to prove (otherwise this probe isn't a resume at all).
    const instance = this.deps.getInstance(instanceId);
    const proofSessionId = instance?.providerSessionId ?? instance?.sessionId;
    const surfaceProof = !!instance && !!proofSessionId;
    if (surfaceProof) {
      this.deps.queueUpdate(instanceId, instance!.status, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
        kind: 'resume-proof',
        provider: instance!.provider,
        sessionId: proofSessionId,
        startedAt: Date.now(),
        deadlineAt: Date.now() + timeoutMs,
      });
    }
    try {
      const healthy = await this.runtimeReadiness.waitForResumeHealth(instanceId, timeoutMs, pollIntervalMs);
      if (!healthy) {
        return false;
      }

      const resumeResult = this.getAdapterResumeAttemptResult(instanceId);
      if (!resumeResult || resumeResult.source === 'none') {
        return true;
      }

      if (!resumeResult.confirmed) {
        // Distinguish the EXPECTED case (the adapter never attempted native
        // resume because no transcript exists for this session under the cwd —
        // e.g. a first turn that was blocked on a permission prompt and never
        // flushed) from a genuine anomaly (resume WAS attempted but the CLI
        // didn't echo back the requested session id). Both fall back to
        // fresh+replay, but only the latter is worth a warning. Logging the
        // expected case as a warn made routine degradation look like a constant
        // failure.
        if (resumeResult.source === 'fresh-fallback') {
          logger.info('Native resume unavailable (no transcript for session under cwd); starting fresh with replay', {
            instanceId,
            requestedSessionId: resumeResult.requestedSessionId,
          });
        } else {
          logger.warn('Adapter did not confirm native resume after readiness probe', {
            instanceId,
            source: resumeResult.source,
            requestedSessionId: resumeResult.requestedSessionId,
            actualSessionId: resumeResult.actualSessionId,
            reason: resumeResult.reason,
          });
        }
        return false;
      }

      return true;
    } finally {
      if (surfaceProof) {
        // Clear the resume-proof reason; the caller (respawn) sets its own next
        // reason or the instance settles to ready/idle which clears it anyway.
        const cur = this.deps.getInstance(instanceId);
        if (cur) {
          this.deps.queueUpdate(instanceId, cur.status, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null);
        }
      }
    }
  }

  private getAdapterResumeAttemptResult(instanceId: string): ResumeAttemptResult | null {
    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter) return null;
    const snapshotProof = getProviderRuntimeService().getRuntimeSnapshot(adapter)?.resumeProof;
    if (snapshotProof) return snapshotProof;
    if (typeof (adapter as { getResumeAttemptResult?: unknown }).getResumeAttemptResult !== 'function') return null;

    return (adapter as { getResumeAttemptResult: () => ResumeAttemptResult | null }).getResumeAttemptResult();
  }

  private async waitForAdapterWritable(
    instanceId: string,
    timeoutMs = 3000,
    pollIntervalMs = 100,
  ): Promise<boolean> {
    return this.runtimeReadiness.waitForAdapterWritable(instanceId, timeoutMs, pollIntervalMs);
  }

  private async waitForInputReadinessBoundary(
    instanceId: string,
    adapter?: CliAdapter,
  ): Promise<void> {
    await this.runtimeReadiness.waitForInputReadinessBoundary(instanceId, adapter);
  }

  private prepareStatusForAdapterInput(instance: Instance): void {
    if (instance.status === 'initializing') {
      this.transitionState(instance, 'idle');
      return;
    }

    if (instance.status === 'waking') {
      this.transitionState(instance, 'ready');
    }
  }

  // ============================================
  // Instruction Prompt Loading
  // ============================================

  /**
   * Load instruction hierarchy with backward compatibility:
   * 1) ~/.orchestrator/INSTRUCTIONS.md
   * 2) ~/.claude/CLAUDE.md (legacy)
   * 3) <workDir>/.orchestrator/INSTRUCTIONS.md
   * 4) <workDir>/.claude/CLAUDE.md (legacy)
   */
  private async loadPromptHierarchy(workDir: string): Promise<string[]> {
    const resolution = await resolveInstructionStack({
      workingDirectory: workDir,
    });

    for (const source of resolution.sources) {
      logger.debug('Resolved instruction source for instance prompt', {
        path: source.path,
        label: source.label,
        loaded: source.loaded,
        applied: source.applied,
        reason: source.reason,
      });
    }

    return resolution.mergedContent
      ? resolution.mergedContent.split('\n\n---\n\n')
      : [];
  }

  // ============================================
  // Instance Creation
  // ============================================

  /**
   * Create a new instance.
   *
   * Phase 1 (synchronous, <5ms): build the instance object, register it in the
   * store and supervisor tree, then return immediately.
   *
   * Phase 2 (background async): load instructions, resolve provider/model,
   * build the system prompt, spawn the CLI adapter, and send the initial
   * prompt. `instance.readyPromise` resolves (or rejects) when Phase 2 is
   * done. `sendInput()` awaits this promise before sending any user input.
   */
  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    logger.info('Creating instance', summarizeCreateInstanceConfig(config));

    // Resolve agent profile (built-in + optional markdown-defined).
    // This is async but lightweight (registry lookup); it is needed to
    // populate agentId / agentMode on the instance object before we return.
    const resolvedAgent = await getAgentRegistry().resolveAgent(
      config.workingDirectory,
      config.agentId || null
    );

    const instance = buildInstanceRecord(config, resolvedAgent, {
      defaultYoloMode: this.settings.getAll().defaultYoloMode,
      getParent: (id) => this.deps.getInstance(id),
    });
    const abortController = instance.abortController!;
    const spawnTransaction = createSpawnTransaction(`create:${instance.id}`);

    // Load project permission rules early so the first prompts can be auto-decided.
    try {
      getPermissionManager().loadProjectRules(instance.workingDirectory);
    } catch {
      /* intentionally ignored: project rules are optional and failure should not block instance creation */
    }

    // =========================================================================
    // Phase 1: build and register the instance object, then return immediately.
    // =========================================================================

    if (instance.yoloMode) {
      logger.warn('YOLO mode enabled for instance', {
        instanceId: instance.id,
        parentId: instance.parentId,
        provider: instance.provider
      });
    }

    // Store instance so UI renders immediately
    this.deps.setInstance(instance);
    spawnTransaction.addRollback('instance-state', () => {
      this.deps.deleteInstance(instance.id);
      this.emit('removed', instance.id);
    });
    spawnTransaction.addRollback('output-storage', () => this.outputStorage.deleteInstance(instance.id));

    // Initialize state machine for this instance (starts in 'initializing').
    this.deps.setStateMachine?.(instance.id, new InstanceStateMachine('initializing'));
    spawnTransaction.addRollback('state-machine', () => { this.deps.deleteStateMachine?.(instance.id); });

    // If has parent, update parent's children list
    if (instance.parentId) {
      const parent = this.deps.getInstance(instance.parentId);
      if (parent) {
        parent.childrenIds.push(instance.id);
        spawnTransaction.addRollback('parent-child-link', () => {
          parent.childrenIds = parent.childrenIds.filter((childId) => childId !== instance.id);
        });
      }
    }

    // Register with supervisor tree
    const supervisorTree = getSupervisorTree();
    const { supervisorNodeId, workerNodeId } = supervisorTree.registerInstance(
      instance.id,
      instance.parentId,
      instance.workingDirectory,
      instance.displayName,
      instance.terminationPolicy,
      instance.contextInheritance
    );
    instance.supervisorNodeId = supervisorNodeId;
    instance.workerNodeId = workerNodeId;
    spawnTransaction.addRollback('supervisor-tree', () => { getSupervisorTree().unregisterInstance(instance.id); });

    // Emit creation event immediately with 'initializing' status so the UI
    // can render the instance card without waiting for the heavy init below.
    logger.debug('Emitting instance:created event (initializing)', { instanceId: instance.id });
    this.deps.registerOrchestration(
      instance.id,
      instance.workingDirectory,
      instance.parentId
    );
    spawnTransaction.addRollback('orchestration-registry', () => { this.deps.unregisterOrchestration(instance.id); });
    this.emit('created', this.deps.serializeForIpc(instance));

    // Initial prompts never flow through InstanceManager.sendInput(), so kick
    // off title generation here before the background spawn/send pipeline. Fire
    // even when only a file is attached (no typed text) so the thread is titled
    // from the attachment instead of a generic placeholder.
    const initialPromptText = typeof config.initialPrompt === 'string' ? config.initialPrompt : '';
    const initialAttachmentNames = config.attachments?.map((a) => a.name);
    if (initialPromptText.trim().length > 0 || (initialAttachmentNames?.length ?? 0) > 0) {
      this.triggerAutoTitle(instance, initialPromptText, initialAttachmentNames);
    }
    if (initialPromptText.trim().length > 0) {
      try {
        const promptHistoryService = getPromptHistoryService();
        promptHistoryService.record({
          instanceId: instance.id,
          id: createPromptHistoryEntryId(),
          text: initialPromptText.trim(),
          createdAt: Date.now(),
          projectPath: instance.workingDirectory,
          provider: config.provider,
          model: config.modelOverride || resolvedAgent.modelOverride,
          wasSlashCommand: false,
        });
        spawnTransaction.addRollback('prompt-history', () => {
          promptHistoryService.clearForInstance(instance.id);
        });
      } catch (error) {
        logger.warn('Failed to record initial prompt history in main process', {
          instanceId: instance.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Restored sessions (history-restore, native resume, thread wakeup) are a
    // continuation of an existing, already-named thread. The first real message
    // after restore is a continuation, not a genuine first message — so
    // suppress auto-title re-firing (which would overwrite the restored
    // displayName with a title derived from the follow-up message) and
    // orchestration-prompt re-prepending (which was already applied to
    // the original first message).
    //
    // `isRestoredSession` is the authoritative signal from the restore
    // coordinator and applies even when the prior transcript could not be
    // loaded into `initialOutputBuffer` (empty/pruned history) — the case the
    // buffer-content heuristic below silently missed, letting an auto-titled
    // (non-user-renamed) session lose its name on the next message. The
    // heuristic is kept as a fallback for any restore-like caller that
    // pre-populates a transcript without setting the flag.
    const hasRestoredConversation = config.initialOutputBuffer?.some(
      (msg) => msg.type === 'user' || msg.type === 'assistant'
    ) ?? false;
    const hasInitialPrompt =
      typeof config.initialPrompt === 'string'
      && config.initialPrompt.trim().length > 0;
    if (config.isRestoredSession || (hasRestoredConversation && !hasInitialPrompt)) {
      this.deps.markFirstMessageReceived(instance.id);
    }

    // =========================================================================
    // Phase 2: heavy async init runs in the background.
    // All callers that need the instance to be fully ready must await
    // instance.readyPromise (sendInput does this automatically).
    // =========================================================================

    // Attach a no-op rejection handler so that if Phase 2 fails before
    // sendInput() gets a chance to await it, we don't emit an unhandled
    // rejection. The error is still observable via sendInput().
    const backgroundInit = (async () => {
      const { signal } = abortController;
      const seededInitialUserMessage = getSeededInitialUserMessage(config);
      const initialUserMessage =
        seededInitialUserMessage ?? createInitialUserMessage(config);
      try {
        if (signal.aborted) return;

        // Initialize RLM
        await this.deps.initializeRlm(instance);
        spawnTransaction.addRollback('rlm-session', () => { this.deps.endRlmSession(instance.id); });

        if (signal.aborted) return;

        // Ingest initial output buffer to RLM
        if (config.initialOutputBuffer && config.initialOutputBuffer.length > 0) {
          this.deps.ingestInitialOutputToRlm(instance, config.initialOutputBuffer);
        }

        const toolPermissions = buildToolPermissionConfig(resolvedAgent.permissions, {
          allowedToolsPolicy: 'allow-all',
        });
        attachToolFilterMetadata(instance, toolPermissions.toolFilter);

        // Load instruction hierarchy (skip for child instances to reduce token overhead)
        const instructionPrompts = instance.depth === 0
          ? await this.loadPromptHierarchy(instance.workingDirectory)
          : [];

        if (signal.aborted) return;

        // Build system prompt with instruction content prepended
        let systemPrompt = resolvedAgent.systemPrompt || '';
        if (instructionPrompts.length > 0) {
          const instructionSection = instructionPrompts.join('\n\n---\n\n');
          systemPrompt = `${instructionSection}\n\n---\n\n${systemPrompt}`;
          logger.info('Prepended instruction prompts to system prompt', { count: instructionPrompts.length });
        }

        // Output style (claude2_todo #29): append the selected communication-style
        // directive for root sessions on system-prompt-injectable providers.
        // Default 'default' is a no-op, so this is inert unless the user opts in.
        if (instance.depth === 0) {
          const outputStyle = this.settings.getAll().outputStyle;
          if (outputStyle && outputStyle !== 'default' && isOutputStyleInjectableProvider(config.provider)) {
            let styled = systemPrompt;
            if (isOutputStyleName(outputStyle)) {
              // Built-in style (unchanged behaviour — append-only).
              styled = applyOutputStyle(systemPrompt, outputStyle);
            } else {
              // User-authored `.md` style: append or full-prompt-swap (mode: replace).
              const userStyle = await getOutputStyleRegistry()
                .resolveUserStyle(instance.workingDirectory, outputStyle)
                .catch((err) => {
                  logger.warn('User output-style resolution failed', { outputStyle, error: String(err) });
                  return null;
                });
              if (userStyle) {
                styled = applyResolvedOutputStyle(systemPrompt, userStyle);
              }
            }
            if (styled !== systemPrompt) {
              systemPrompt = styled;
              logger.info('Applied output style to system prompt', { outputStyle });
            }
          }
        }

        // Inject observation memory context (learned reflections from past sessions).
        // Deadline-bounded and off-thread via the context worker.
        try {
        const observationContext = await callWithDeadline(
          this.deps.buildObservationContext(systemPrompt, instance.id, config.initialPrompt),
          {
            ms: CREATE_ENRICHER_DEADLINE_MS,
            fallback: '',
              onTimeout: () =>
                logger.info('Observation context exceeded create deadline; deferring to next turn', {
                  instanceId: instance.id,
                }),
              onError: (err) =>
                logger.warn('Failed to inject observation context', {
                  error: err instanceof Error ? err.message : String(err),
                }),
              onLateResult: (text) => this.deferEnricherPreamble(instance.id, 'observation', text),
            },
          );
          if (observationContext) {
            systemPrompt = `${systemPrompt}\n\n---\n\n${observationContext}`;
            logger.info('Injected observation memory context into system prompt');
          }
        } catch (err) {
          logger.warn('Failed to inject observation context', { error: err instanceof Error ? err.message : String(err) });
        }

        // Inject a compact, project-scoped memory brief for fresh root sessions.
        if (instance.depth === 0 && !isRestoreOrReplayContinuity(config)) {
          try {
            const projectBriefRequest = {
              projectPath: instance.workingDirectory,
              instanceId: instance.id,
              initialPrompt: config.initialPrompt,
              provider: config.provider,
              model: config.modelOverride || resolvedAgent.modelOverride || this.settings.getAll().defaultModel,
            };
            let projectBrief = await getContextWorkerClient()
              .buildProjectMemoryBrief(projectBriefRequest)
              .catch((error) => {
                logger.warn('Context worker failed to build project memory brief; falling back to main process', {
                  error: error instanceof Error ? error.message : String(error),
                });
                return null;
              });
            projectBrief ??= await getProjectMemoryBriefService().buildBrief(projectBriefRequest);
            if (projectBrief.text.trim()) {
              systemPrompt = `${systemPrompt}\n\n---\n\n${projectBrief.text}`;
              logger.info('Injected project memory brief into system prompt', {
                projectKey: projectBrief.stats.projectKey,
                candidatesScanned: projectBrief.stats.candidatesScanned,
                candidatesIncluded: projectBrief.stats.candidatesIncluded,
                sourceCounts: projectBrief.sources.reduce<Record<string, number>>((counts, source) => {
                  counts[source.type] = (counts[source.type] ?? 0) + 1;
                  return counts;
                }, {}),
                truncated: projectBrief.stats.truncated,
              });
            }
          } catch (err) {
            logger.warn('Failed to inject project memory brief', {
              error: err instanceof Error ? err.message : String(err),
              instanceId: instance.id,
            });
          }
        }

        // A7#15: inject authored project lessons (.aio/lessons.md) into fresh
        // root sessions. The file is git-trackable and written by humans/agents;
        // injecting it carries hard-won knowledge into the next session. Skipped
        // when the file holds only its skeleton placeholder (no real entries).
        if (instance.depth === 0 && !isRestoreOrReplayContinuity(config)) {
          try {
            const lessons = extractAuthoredLessons({ projectRoot: instance.workingDirectory });
            if (lessons) {
              systemPrompt = `${systemPrompt}\n\n---\n\n${lessons}`;
              logger.info('Injected project lessons into system prompt', {
                instanceId: instance.id,
                chars: lessons.length,
              });
            }
          } catch (err) {
            logger.warn('Failed to inject project lessons', {
              error: err instanceof Error ? err.message : String(err),
              instanceId: instance.id,
            });
          }
        }

        // E14: inject a compact ranked repo map for fresh root sessions so the
        // agent has structural project context without reading every file.
        if (instance.depth === 0 && !isRestoreOrReplayContinuity(config)
            && instance.workingDirectory && this.settings.getAll().injectRepoMap) {
          try {
            const { getRepoMapService } = await import('../memory/repo-map-service');
            const repoMap = await getRepoMapService().buildRepoMap({
              projectPath: instance.workingDirectory,
              tokenBudget: this.settings.getAll().repoMapTokenBudget,
            });
            if (repoMap.text.trim()) {
              systemPrompt = `${systemPrompt}\n\n---\n\n${repoMap.text}`;
              logger.info('Injected repo map into system prompt', {
                instanceId: instance.id,
                filesIncluded: repoMap.stats.filesIncluded,
                filesConsidered: repoMap.stats.filesConsidered,
                tokensUsed: repoMap.stats.tokensUsed,
                truncated: repoMap.stats.truncated,
                fallback: repoMap.stats.fallback,
              });
            }
          } catch (err) {
            logger.warn('Failed to inject repo map', {
              error: err instanceof Error ? err.message : String(err),
              instanceId: instance.id,
            });
          }
        }

        // Inject wake-up context (mempalace L0 identity + L1 essential story)
        if (instance.depth === 0) {
          try {
            const wakeText = await callWithDeadline(
              () => this.deps.buildWakeContextText(instance.workingDirectory),
              {
                ms: CREATE_ENRICHER_DEADLINE_MS,
                fallback: null,
                onTimeout: () =>
                  logger.info('Wake context exceeded create deadline; continuing without it', {
                    instanceId: instance.id,
                  }),
                onError: (error) =>
                  logger.warn('Failed to build wake context off-thread', {
                    instanceId: instance.id,
                    error: error instanceof Error ? error.message : String(error),
                  }),
              },
            );
            if (wakeText && wakeText.trim().length > 30) {
              systemPrompt = `${systemPrompt}\n\n---\n\n${wakeText}`;
              logger.info('Injected wake-up context into system prompt', {
                tokenEstimate: sharedEstimateTokens(wakeText),
              });
            }
          } catch (err) {
            logger.warn('Failed to inject wake context', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Register and refresh project knowledge for the working directory (async, fire-and-forget).
        if (instance.depth === 0 && instance.workingDirectory) {
          getProjectKnowledgeCoordinator().ensureProjectKnown(
            instance.workingDirectory,
            'instance-working-directory',
            { autoRefresh: true },
          ).catch((err) => {
            logger.warn('Codebase mining failed', {
              error: err instanceof Error ? err.message : String(err),
              workingDirectory: instance.workingDirectory,
            });
          });
        }

        const initialRuntimeContextBlock = await this.buildInitialRuntimeContextBlock(
          instance,
          config,
          initialUserMessage?.content,
        );

        // MCP runtime tool selection. Deadline-bounded: a slow tool-load (or a
        // large connector set) defers into the next turn rather than holding up
        // the first send.
        try {
          const mcpManager = getMcpManager();
          const runtimeToolSelection = await callWithDeadline<
            McpRuntimeToolContextSelection | null
          >(
            () =>
              this.deps.buildMcpRuntimeToolContextSelection(
                mcpManager.exportRuntimeToolContextSnapshot(),
                config.initialPrompt,
                6,
              ),
            {
              ms: CREATE_ENRICHER_DEADLINE_MS,
              fallback: null,
              onTimeout: () =>
                logger.info('MCP tool context exceeded create deadline; deferring to next turn', {
                  instanceId: instance.id,
                }),
              onLateResult: (selection) => {
                if (!selection) {
                  return;
                }
                void mcpManager
                  .hydrateRuntimeToolContextSelection(selection)
                  .then((ctx) => {
                    this.deferEnricherPreamble(
                      instance.id,
                      'mcp',
                      mcpManager.formatRuntimeToolContext(ctx),
                    );
                  })
                  .catch((error) => {
                    logger.warn('Failed to hydrate deferred MCP tool context', {
                      instanceId: instance.id,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  });
              },
            },
          );
          const runtimeToolContext = runtimeToolSelection
            ? await mcpManager.hydrateRuntimeToolContextSelection(runtimeToolSelection)
            : null;
          const mcpPrompt = runtimeToolContext
            ? mcpManager.formatRuntimeToolContext(runtimeToolContext)
            : null;
          if (runtimeToolContext && mcpPrompt) {
            systemPrompt = `${systemPrompt}\n\n---\n\n${mcpPrompt}`;
            logger.info('Injected deferred MCP runtime tool context into system prompt', {
              selectedTools: runtimeToolContext.selectedTools.length,
              deferredToolCount: runtimeToolContext.deferredToolCount,
              serverCount: runtimeToolContext.serverSummaries.length,
            });
          }
        } catch (err) {
          logger.warn('Failed to inject MCP runtime tool context', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        systemPrompt += `\n\n---\n\n${buildToolPermissionPrompt(instance.yoloMode)}`;

        if (signal.aborted) return;

        // Resolve CLI provider type
        const settingsAll = this.settings.getAll();
        const localModelTarget = config.modelRuntimeTarget?.kind === 'local-model'
          ? config.modelRuntimeTarget
          : null;
        logger.debug('Resolving provider', {
          requested: config.provider,
          default: settingsAll.defaultCli
        });
        const resolvedCliType = await resolveCliType(
          config.provider,
          settingsAll.defaultCli
        );

        if (signal.aborted) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CliType (cli-detection) vs CliType (settings) mismatch
        instance.provider = resolvedCliType as any;
        logger.info('Resolved CLI provider', {
          cliType: resolvedCliType,
          displayName: getCliDisplayName(resolvedCliType)
        });

        // Resolve model: explicit override > agent override > per-provider
        // remembered (defaultModelByProvider, persisted by the renderer's
        // provider-state.service) > legacy global default. A8a: honoring the
        // per-provider map here makes a backend spawn start on the same model the
        // picker pre-selects for this provider.
        const settingsModel = settingsAll.defaultModel;
        let resolvedModel = localModelTarget?.modelId ?? resolveInitialModel({
            configModelOverride: config.modelOverride,
            agentModelOverride: resolvedAgent.modelOverride,
            provider: resolvedCliType,
            defaultModelByProvider: settingsAll.defaultModelByProvider,
            defaultModel: settingsModel,
          });

        if (resolvedModel && !localModelTarget) {
          if (isModelTier(resolvedModel)) {
            const tierResolved = resolveModelForTier(resolvedModel, resolvedCliType);
            logger.info('Resolved model tier to provider-specific model', {
              tier: resolvedModel,
              provider: resolvedCliType,
              resolvedModel: tierResolved || 'provider-default',
            });
            resolvedModel = tierResolved;
          }

          if (resolvedModel) {
            const providerModels = await getKnownModelsForCli(resolvedCliType);
            const selection = resolveAvailableModelSelection({
              provider: resolvedCliType,
              requestedModel: resolvedModel,
              knownModelIds: providerModels,
              fallbackModel: getDefaultModelForCli(resolvedCliType),
              allowDynamicCodexModel:
                resolvedCliType === 'codex' && looksLikeCodexModelId(resolvedModel),
            });
            if (selection.degradation) {
              logger.warn('Model not valid for target provider, falling back to provider default', {
                model: selection.degradation.requestedModel,
                provider: resolvedCliType,
                validModelCount: providerModels.length,
                fallbackModel: selection.degradation.fallbackModel ?? 'provider-default',
              });
              this.emitModelSelectionDegradation(instance, selection.degradation);
            }
            resolvedModel = selection.model;
          }
        }

        instance.currentModel = resolvedModel;
        instance.reasoningEffort = config.reasoningEffort;

        // Fast mode: explicit per-instance override > per-provider remembered >
        // global default. Stored on the instance so respawns (yolo/model/agent
        // toggles, hibernate-wake) and the live fast toggle carry it forward.
        const resolvedFastMode = resolveFastMode({
          configOverride: config.fastModeOverride,
          provider: resolvedCliType,
          defaultFastModeByProvider: settingsAll.defaultFastModeByProvider,
          defaultFastMode: settingsAll.defaultFastMode,
        });
        instance.fastMode = resolvedFastMode;
        instance.residentClaude = settingsAll.residentClaudeSession ?? true;
        instance.contextUsage = {
          ...instance.contextUsage,
          total: getProviderModelContextWindow(resolvedCliType, resolvedModel),
          percentage: 0
        };

        logger.info('Resolved model for instance', {
          configOverride: config.modelOverride,
          agentOverride: resolvedAgent.modelOverride,
          perProviderRemembered: settingsAll.defaultModelByProvider?.[resolvedCliType],
          settingsDefault: settingsModel,
          resolved: resolvedModel,
        });

        // Create CLI adapter - use resolved model
        const modelOverride = resolvedModel;
        const spawnOptions: UnifiedSpawnOptions = {
          instanceId: instance.id,
          sessionId: instance.sessionId,
          workingDirectory: instance.workingDirectory,
          systemPrompt: systemPrompt,
          model: modelOverride,
          yoloMode: instance.yoloMode,
          launchMode: instance.launchMode,
          bare: instance.bareMode === true,
          reasoningEffort: config.reasoningEffort,
          fastMode: resolvedFastMode,
          residentClaude: this.residentClaudeForSpawn(instance),
          allowedTools: toolPermissions.allowedTools,
          disallowedTools: toolPermissions.disallowedToolsForSpawn,
          resume: config.resume,
          mcpConfig: this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, resolvedCliType),
          chromeDevtoolsMcp: this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
          browserGatewayMcp: this.spawnConfigBuilder.getBrowserGatewayMcpOptions(
            instance.executionLocation,
            instance.id,
            resolvedCliType,
          ) ?? undefined,
          nodePlacement: instance.nodePlacement,
          permissionHookPath: this.spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
          rtk: this.spawnConfigBuilder.getRtkSpawnConfig(),
          modelRuntimeTarget: config.modelRuntimeTarget,
        };

        // Check for a pre-warmed adapter before spawning fresh.
        // NEVER use warm-start for resume operations — warm adapters have fresh sessions
        // with no conversation context. Resume requires --resume <sessionId> on a freshly
        // spawned CLI process.
        // NEVER use warm-start for remote sessions — warm adapters are local processes
        // and cannot proxy commands to a remote worker node.
        // NEVER use warm-start for providers whose explicit model is fixed on
        // the adapter at spawn/prewarm time. Cursor/Copilot bind `--model` at
        // ACP session creation; Antigravity stores the exact `agy --model`
        // label on the adapter config. Reusing a warm process would silently
        // ignore the user's model pick. `auto`/unset is fine: it intentionally
        // means "let the CLI pick".
        const wantsExplicitConfiguredModel = requiresFreshConfiguredModelSpawn(resolvedCliType, spawnOptions.model);
        const warmAdapter = (config.resume || config.forceNodeId || config.nodePlacement || config.modelRuntimeTarget || spawnOptions.browserGatewayMcp || wantsExplicitConfiguredModel || instance.bareMode === true)
          ? null
          : (this.deps.warmStartManager?.consume(resolvedCliType, instance.workingDirectory) as CliAdapter | null ?? null);

        let adapter: CliAdapter;
        if (warmAdapter) {
          logger.info('Using warm-start adapter (skipping spawn)', { provider: resolvedCliType, instanceId: instance.id });
          adapter = warmAdapter;

          // Set up adapter events and store the adapter.
          this.deps.setupAdapterEvents(instance.id, adapter);
          this.deps.setAdapter(instance.id, adapter);
          if (this.deps.setDiffTracker) {
            this.deps.setDiffTracker(instance.id, new SessionDiffTracker(instance.workingDirectory));
          }
          this.addAdapterRollback(spawnTransaction, instance.id, adapter);

          if (signal.aborted) {
            await adapter.terminate(false).catch(() => { /* ignore */ });
            this.deps.deleteAdapter(instance.id);
            return;
          }

          await this.waitForInputReadinessBoundary(instance.id, adapter);

          // The warm adapter is already spawned; mark the instance as idle.
          this.transitionState(instance, 'idle');
          // Phase 2 has now resolved the model. Announce it on the same
          // update so the renderer can stop falling back to availableModels[0]
          // (which is `auto` for Copilot's dynamic list).
          this.deps.queueUpdate(
            instance.id,
            'idle',
            instance.contextUsage,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            instance.currentModel,
          );
          this.deps.startStuckTracking?.(instance.id);
          logger.info('Warm-start instance ready', { instanceId: instance.id });

          // Send initial prompt if provided.
          if (initialUserMessage) {
            if (!seededInitialUserMessage) {
              this.deps.addToOutputBuffer(instance, initialUserMessage);
              this.emit('output', { instanceId: instance.id, message: initialUserMessage });
            }
            try {
              await this.sendInitialPromptWithAttachmentFallback({
                instance,
                adapter,
                resolvedCliType,
                message: initialUserMessage.content,
                contextBlock: initialRuntimeContextBlock,
                attachments: config.attachments,
              });
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error('Failed to send initial prompt via warm adapter', error instanceof Error ? error : undefined, { errorMessage });
              throw error;
            }
          }
        } else {
          const executionLocation = resolveExecutionLocation(config);
          instance.executionLocation = executionLocation;
          await this.assertLocalModelRuntimeAvailable(config.modelRuntimeTarget);
          // Clear local MCP config for remote instances — paths don't exist on workers
          if (executionLocation.type === 'remote') {
            spawnOptions.mcpConfig = [];
            spawnOptions.browserGatewayMcp = undefined;
          } else {
            await this.warmCodememWorkspace(instance.workingDirectory);
          }
          adapter = this.createRuntimeAdapter(resolvedCliType, spawnOptions, executionLocation);

          // Set up adapter events
          this.deps.setupAdapterEvents(instance.id, adapter);

          // Store adapter
          this.deps.setAdapter(instance.id, adapter);
          if (this.deps.setDiffTracker) {
            this.deps.setDiffTracker(instance.id, new SessionDiffTracker(instance.workingDirectory));
          }
          this.addAdapterRollback(spawnTransaction, instance.id, adapter);

          if (signal.aborted) {
            // Clean up the adapter we just registered
            await adapter.terminate(false).catch(() => { /* ignore */ });
            this.deps.deleteAdapter(instance.id);
            return;
          }

          // Spawn the CLI process
          try {
            logger.info('Spawning CLI process', { provider: resolvedCliType });
            const pid = await adapter.spawn();

            if (signal.aborted) {
              await adapter.terminate(false).catch(() => { /* ignore */ });
              this.deps.deleteAdapter(instance.id);
              return;
            }

            instance.processId = pid;
            await this.waitForInputReadinessBoundary(instance.id, adapter);
            // Create activity detector for this instance
            const detector = new ActivityStateDetector(
              instance.id,
              instance.workingDirectory || process.cwd(),
              instance.provider ?? 'claude-cli',
            );
            if (pid) detector.setPid(pid);
            this.activityDetectors.set(instance.id, detector);
            // Inject detector into adapter if it supports activity recording
            const adapterForDetector = this.deps.getAdapter(instance.id);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setActivityDetector is not in CliAdapter interface; runtime check guards the call
            const adapterWithDetector = adapterForDetector as any;
            if (adapterForDetector && typeof adapterWithDetector.setActivityDetector === 'function') {
              adapterWithDetector.setActivityDetector(detector);
            }
            this.transitionState(instance, 'idle');
            // Phase 2 has now resolved the model. Announce it on the same
            // update so the renderer can stop falling back to availableModels[0]
            // (which is `auto` for Copilot's dynamic list).
            this.deps.queueUpdate(
              instance.id,
              'idle',
              instance.contextUsage,
              undefined,
              undefined,
              undefined,
              instance.executionLocation,
              undefined,
              undefined,
              instance.currentModel,
            );
            this.deps.startStuckTracking?.(instance.id);
            logger.info('CLI spawned successfully', { pid, instanceId: instance.id });

            // Send initial prompt if provided
            if (initialUserMessage) {
              if (!seededInitialUserMessage) {
                this.deps.addToOutputBuffer(instance, initialUserMessage);
                this.emit('output', { instanceId: instance.id, message: initialUserMessage });
              }
              await this.sendInitialPromptWithAttachmentFallback({
                instance,
                adapter,
                resolvedCliType,
                message: initialUserMessage.content,
                contextBlock: initialRuntimeContextBlock,
                attachments: config.attachments,
              });
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Failed to spawn/initialize CLI', error instanceof Error ? error : undefined, { errorMessage });
            throw error;
          }
        }

        // After a successful spawn/warm-start, pre-warm a replacement process in
        // the background for the next createInstance call of the same provider.
        // Skipped for resume restores (the spare expires unused on its 5 minute
        // TTL) and for remote instances (their working directory lives on
        // another machine — a local pre-warm would spawn with a nonexistent
        // cwd and fail with a misleading `spawn <cli> ENOENT`).
        if (this.deps.warmStartManager && shouldPreWarmReplacement(config.resume, instance.executionLocation)) {
          const wsm = this.deps.warmStartManager;
          const warmProvider = resolvedCliType;
          const warmWorkingDir = instance.workingDirectory;
          // Fire and forget — errors are handled inside preWarm.
          void wsm.preWarm(warmProvider, warmWorkingDir);
        } else if (this.deps.warmStartManager) {
          logger.info('Skipping warm-start replacement spawn', {
            provider: resolvedCliType,
            instanceId: instance.id,
            sessionId: instance.sessionId,
            reason: config.resume ? 'resumed session' : 'remote instance',
          });
        }

        spawnTransaction.commit();
      } catch (error) {
        if (!signal.aborted) {
          await spawnTransaction.rollback(error);
          logger.error('Instance background init failed', error instanceof Error ? error : undefined, { instanceId: instance.id });
        }
        throw error;
      } finally {
        instance.readyPromise = undefined;
        instance.abortController = undefined;
      }
    })();

    // Store the promise so sendInput() can await it.
    instance.readyPromise = backgroundInit;
    // Attach a no-op catch on a separate chain so that if no one awaits
    // readyPromise before it rejects, Node doesn't emit an unhandled rejection.
    backgroundInit.catch(() => { /* rejection handled via sendInput() status check */ });

    return instance;
  }

  // ============================================
  // Instance Termination
  // ============================================

  /**
   * Terminate an instance
   */
  async terminateInstance(
    instanceId: string,
    graceful = true
  ): Promise<void> {
    await this.terminator.terminateInstance(instanceId, graceful);
  }

  /**
   * Terminate all instances
   */
  async terminateAll(): Promise<void> {
    const instanceIds: string[] = [];
    this.deps.forEachInstance((_, id) => instanceIds.push(id));

    const promises = instanceIds.map((id) =>
      this.terminator.terminateInstance(id, false, { skipTranscriptMining: true })
    );
    await Promise.all(promises);
  }

  // ============================================
  // Hibernation
  // ============================================

  /**
   * Hibernate an instance: save state, kill the adapter process, and mark the
   * instance as hibernated. The instance stays in the store so the UI can show
   * it. Call wakeInstance() to bring it back.
   */
  async hibernateInstance(instanceId: string): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (instance.status !== 'idle') {
      throw new Error(
        `Cannot hibernate instance ${instanceId}: status is '${instance.status}', expected 'idle'`
      );
    }

    this.transitionState(instance, 'hibernating');
    this.deps.queueUpdate(instanceId, 'hibernating', instance.contextUsage);

    try {
      // Persist session state to disk (archive=true keeps the file for wake).
      const continuity = getSessionContinuityManager();
      await continuity.startTracking(instance);
      await continuity.stopTracking(instanceId, true);

      this.terminator.mineTranscript(instanceId, instance, 'hibernate');

      // Kill the adapter process without removing the instance from the store.
      const adapter = this.deps.getAdapter(instanceId);
      if (adapter) {
        await adapter.terminate(true);
        this.deps.deleteAdapter(instanceId);
      }
      this.deps.deleteDiffTracker?.(instanceId);

      instance.processId = null;

      // Record in HibernationManager.
      getHibernationManager().markHibernated(instanceId, {
        instanceId,
        displayName: instance.displayName,
        agentId: instance.agentId,
        sessionState: {},
        hibernatedAt: Date.now(),
        workingDirectory: instance.workingDirectory,
        contextUsage: {
          used: instance.contextUsage.used,
          total: instance.contextUsage.total,
        },
      });

      this.transitionState(instance, 'hibernated');
      this.deps.queueUpdate(instanceId, 'hibernated', instance.contextUsage);
      logger.info('Instance hibernated', { instanceId, displayName: instance.displayName });
    } catch (error) {
      this.transitionState(instance, 'failed');
      this.deps.queueUpdate(instanceId, 'failed', instance.contextUsage);
      logger.error('Failed to hibernate instance', error instanceof Error ? error : undefined, { instanceId });
      throw error;
    }
  }

  /**
   * Wake a hibernated instance: restore session state and spawn a new adapter.
   */
  async wakeInstance(instanceId: string): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (instance.status !== 'hibernated') {
      throw new Error(
        `Cannot wake instance ${instanceId}: status is '${instance.status}', expected 'hibernated'`
      );
    }

    this.transitionState(instance, 'waking');
    this.deps.queueUpdate(instanceId, 'waking', instance.contextUsage);

    const abortController = new AbortController();
    instance.abortController = abortController;

    const wakePromise = (async () => {
      const { signal } = abortController;
      const spawnTransaction = createSpawnTransaction(`wake:${instanceId}`);
      try {
        if (signal.aborted) return;

        // Load saved session state from disk.
        const continuity = getSessionContinuityManager();
        const sessionState = await continuity.resumeSession(instanceId, {
          restoreMessages: true,
          restoreContext: true,
        });

        const savedThreadId =
          sessionState?.historyThreadId?.trim() || instance.historyThreadId;
        instance.historyThreadId = savedThreadId;
        if (sessionState?.displayName) {
          instance.displayName = sessionState.displayName;
        }
        if (sessionState?.isRenamed) {
          instance.isRenamed = sessionState.isRenamed;
        }
        if (sessionState?.provider) {
          instance.provider = sessionState.provider;
        }
        if (sessionState?.modelId) {
          instance.currentModel = sessionState.modelId;
        }
        if (sessionState?.contextUsage) {
          instance.contextUsage = {
            used: sessionState.contextUsage.used,
            total: sessionState.contextUsage.total,
            percentage: sessionState.contextUsage.total > 0
              ? Math.min(
                  (sessionState.contextUsage.used / sessionState.contextUsage.total) * 100,
                  100
                )
              : 0,
            costEstimate: sessionState.contextUsage.costEstimate,
          };
        }

        if (sessionState && sessionState.conversationHistory.length > 0) {
          // Restore recent messages into the output buffer so the UI can show them.
          const restored = sessionState.conversationHistory.slice(-50).map((entry, idx) => ({
            id: `restored-${idx}-${Date.now()}`,
            timestamp: entry.timestamp,
            type: (entry.role === 'user' ? 'user'
              : entry.role === 'assistant' ? 'assistant'
              : 'system') as OutputMessage['type'],
            content: entry.content,
          }));
          instance.outputBuffer = restored;
        }

        if (signal.aborted) return;

        const nativeSessionId = sessionState?.sessionId?.trim();
        const hasConversation = instance.outputBuffer.some(
          (message) => message.type === 'user' || message.type === 'assistant'
        );
        const recoveryPlan = planSessionRecovery({
          instanceId,
          reason: 'wake',
          previousProviderSessionId: nativeSessionId,
          provider: instance.provider,
          model: instance.currentModel,
          agent: instance.agentId,
          cwd: instance.workingDirectory,
          yolo: instance.yoloMode,
          executionLocation: instance.executionLocation.type,
          resumeCursor: sessionState?.resumeCursor ?? null,
          resumeCursorSource: sessionState?.resumeCursor?.scanSource,
          currentConfigFingerprint: computeResumeConfigFingerprint({
            provider: instance.provider,
            model: instance.currentModel,
            cwd: instance.workingDirectory,
          }),
          capabilities: {
            supportsResume: Boolean(nativeSessionId) && !sessionState?.nativeResumeFailedAt,
            supportsForkSession: false,
          },
          activeTurnId: instance.activeTurnId,
          adapterGeneration: instance.adapterGeneration ?? 0,
          hasConversation,
          sessionResumeBlacklisted: instance.sessionResumeBlacklisted === true,
          providerSessionPersisted: instance.providerSessionPersisted,
        });
        const canAttemptNativeResume =
          (recoveryPlan.kind === 'native-resume' || recoveryPlan.kind === 'provider-fork')
          && Boolean(nativeSessionId)
          && !sessionState?.nativeResumeFailedAt;
        const fallbackReason = canAttemptNativeResume
          ? 'hibernate-wake-fallback'
          : sessionState?.nativeResumeFailedAt
            ? 'hibernate-wake-skip-failed-resume'
            : 'hibernate-wake-replay';

        // Determine CLI type and build spawn options (same pattern as createInstance Phase 2).
        const cliType = await this.resolveCliTypeForInstance(instance);
        instance.sessionId = canAttemptNativeResume
          ? nativeSessionId!
          : generateId();
        const spawnOptions: UnifiedSpawnOptions = {
          instanceId: instance.id,
          sessionId: instance.sessionId,
          workingDirectory: instance.workingDirectory,
          yoloMode: instance.yoloMode,
          launchMode: instance.launchMode,
          bare: instance.bareMode === true,
          model: instance.currentModel,
          fastMode: instance.fastMode,
          residentClaude: this.residentClaudeForSpawn(instance),
          resume: canAttemptNativeResume,
          mcpConfig: this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
          chromeDevtoolsMcp: this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
          browserGatewayMcp: this.spawnConfigBuilder.getBrowserGatewayMcpOptions(
            instance.executionLocation,
            instance.id,
            cliType,
          ) ?? undefined,
          nodePlacement: instance.nodePlacement,
          permissionHookPath: this.spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
          rtk: this.spawnConfigBuilder.getRtkSpawnConfig(),
        };

        let adapter = this.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);
        this.deps.setupAdapterEvents(instanceId, adapter);
        this.deps.setAdapter(instanceId, adapter);
        if (this.deps.setDiffTracker) {
          this.deps.setDiffTracker(instanceId, new SessionDiffTracker(instance.workingDirectory));
        }
        this.addAdapterRollback(spawnTransaction, instanceId, adapter);

        if (signal.aborted) {
          await adapter.terminate(false).catch(() => { /* ignore */ });
          this.deps.deleteAdapter(instanceId);
          this.deps.deleteDiffTracker?.(instanceId);
          return;
        }

        let pid = await adapter.spawn();
        instance.processId = pid;
        await this.waitForInputReadinessBoundary(instanceId, adapter);

        // Create activity detector for woken instance
        const wakeDetector = new ActivityStateDetector(
          instanceId,
          instance.workingDirectory || process.cwd(),
          instance.provider ?? 'claude-cli',
        );
        if (pid) wakeDetector.setPid(pid);
        this.activityDetectors.set(instanceId, wakeDetector);
        // Inject detector into adapter if it supports activity recording
        const wakeAdapter = this.deps.getAdapter(instanceId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setActivityDetector is not in CliAdapter interface; runtime check guards the call
        const wakeAdapterWithDetector = wakeAdapter as any;
        if (wakeAdapter && typeof wakeAdapterWithDetector.setActivityDetector === 'function') {
          wakeAdapterWithDetector.setActivityDetector(wakeDetector);
        }

        if (canAttemptNativeResume) {
          const resumeHealthy = await this.waitForResumeHealth(instanceId);
          if (!resumeHealthy) {
            logger.warn('Wake resume failed, falling back to replay continuity', {
              instanceId,
              nativeSessionId,
            });
            await continuity.markNativeResumeFailed(instanceId);
            // Remove event listeners BEFORE terminating so the exit handler
            // doesn't treat the resume adapter's exit as a real instance exit.
            adapter.removeAllListeners();
            await adapter.terminate(true).catch(() => { /* ignore */ });
            this.deps.deleteAdapter(instanceId);
            this.deps.deleteDiffTracker?.(instanceId);

            const fallbackSessionId = generateId();
            instance.sessionId = fallbackSessionId;
            await continuity.updateState(instanceId, {
              sessionId: fallbackSessionId,
              historyThreadId: instance.historyThreadId,
            });

            const fallbackOptions: UnifiedSpawnOptions = {
              ...spawnOptions,
              sessionId: fallbackSessionId,
              resume: false,
              forkSession: false,
            };
            adapter = this.createRuntimeAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);
            if (this.deps.setDiffTracker) {
              this.deps.setDiffTracker(instanceId, new SessionDiffTracker(instance.workingDirectory));
            }
            this.addAdapterRollback(spawnTransaction, instanceId, adapter);
            pid = await adapter.spawn();
            instance.processId = pid;
            await this.waitForInputReadinessBoundary(instanceId, adapter);

            if (hasConversation) {
              this.prepareStatusForAdapterInput(instance);
              await adapter.sendInput(
                this.buildReplayContinuityMessage(instance, fallbackReason)
              );
            }

            const fallbackNotice: OutputMessage = {
              id: generateId(),
              timestamp: Date.now(),
              type: 'system',
              content: 'Wake resume failed. Session restarted from the saved transcript.',
              metadata: {
                continuityReplay: true,
                reason: fallbackReason,
              },
            };
            this.deps.addToOutputBuffer(instance, fallbackNotice);
            this.emit('output', { instanceId, message: fallbackNotice });
          }
        } else if (hasConversation) {
          this.prepareStatusForAdapterInput(instance);
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, fallbackReason));
        }

        // Remove from HibernationManager tracking.
        getHibernationManager().markAwoken(instanceId);

        this.transitionState(instance, 'ready');
        // Include displayName so the renderer picks up any name restored from session state.
        // Also propagate currentModel — wake restores it from saved session state on
        // line 1615 (instance.currentModel = sessionState.modelId), and like Phase 2 of
        // createInstance, the renderer would otherwise miss the change.
        this.deps.queueUpdate(
          instanceId,
          'ready',
          instance.contextUsage,
          undefined,
          instance.displayName,
          undefined,
          undefined,
          undefined,
          undefined,
          instance.currentModel,
        );
        logger.info('Instance woken successfully', { instanceId, pid });
        spawnTransaction.commit();
      } catch (error) {
        await spawnTransaction.rollback(error);
        this.transitionState(instance, 'failed');
        this.deps.queueUpdate(instanceId, 'failed', instance.contextUsage);
        logger.error('Failed to wake instance', error instanceof Error ? error : undefined, { instanceId });
        throw error;
      } finally {
        instance.readyPromise = undefined;
        instance.abortController = undefined;
      }
    })();

    instance.readyPromise = wakePromise;
    wakePromise.catch(() => { /* rejection surfaced via readyPromise */ });

    await wakePromise;
  }

  private createSessionBoundaryMessage(): OutputMessage {
    return this.restartHelpers.createSessionBoundaryMessage();
  }

  private resetBackendSessionState(
    instance: Instance,
    cliType: CliType,
    options?: { resetTotalTokensUsed?: boolean; resetFirstMessageTracking?: boolean },
  ): void {
    this.restartHelpers.resetBackendSessionState(instance, cliType, options);
  }

  private async archiveRestartSnapshot(instance: Instance, messages: OutputMessage[]): Promise<void> {
    return this.restartHelpers.archiveRestartSnapshot(instance, messages);
  }

  private async nativeResumeAfterRestart(
    instanceId: string,
    providerSessionId: string
  ): Promise<RecoveryResult> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      return { success: false, error: `Instance ${instanceId} not found` };
    }

    const previousAdapter = this.deps.getAdapter(instanceId);
    const capabilities = this.getAdapterRuntimeCapabilities(previousAdapter);
    if (!capabilities.supportsResume || !providerSessionId || instance.sessionResumeBlacklisted) {
      return { success: false, error: 'Native resume unavailable for this session' };
    }

    const cliType = await this.resolveCliTypeForInstance(instance);
    const adapter = this.createRuntimeAdapter(
      cliType,
      {
        instanceId: instance.id,
        sessionId: providerSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        launchMode: instance.launchMode,
        model: instance.currentModel,
        fastMode: instance.fastMode,
        residentClaude: this.residentClaudeForSpawn(instance),
        resume: true,
        forkSession: false,
        mcpConfig: this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
        chromeDevtoolsMcp: this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
        browserGatewayMcp: this.spawnConfigBuilder.getBrowserGatewayMcpOptions(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        nodePlacement: instance.nodePlacement,
        permissionHookPath: this.spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
          rtk: this.spawnConfigBuilder.getRtkSpawnConfig(),
      },
      instance.executionLocation
    );

    this.deps.setupAdapterEvents(instanceId, adapter);
    this.deps.setAdapter(instanceId, adapter);

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      if (!(await this.waitForResumeHealth(instanceId, 15_000))) {
        throw new Error('Native resume did not stabilize');
      }
      await this.waitForAdapterWritable(instanceId, 3_000);
      instance.providerSessionId = providerSessionId;
      instance.sessionId = providerSessionId;
      instance.sessionResumeBlacklisted = false;
      instance.recoveryMethod = 'native';
      return { success: true, method: 'native-resume' };
    } catch (error) {
      instance.processId = null;
      if (this.deps.getAdapter(instanceId) === adapter) {
        this.deps.deleteAdapter(instanceId);
      }
      await adapter.terminate(true).catch(() => { /* ignore cleanup failure */ });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async replayFallbackAfterRestart(
    instanceId: string,
    _providerSessionId: string
  ): Promise<RecoveryResult> {
    void _providerSessionId;
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      return { success: false, error: `Instance ${instanceId} not found` };
    }

    const cliType = await this.resolveCliTypeForInstance(instance);
    const hasConversation = this.hasActiveConversation(instance);
    const fallbackHistory = hasConversation
      ? await this.buildFallbackHistory(instance, 'resume-failed-fallback')
      : undefined;
    const newProviderSessionId = generateId();

    this.resetBackendSessionState(instance, cliType);
    instance.providerSessionId = newProviderSessionId;
    instance.sessionId = newProviderSessionId;
    instance.sessionResumeBlacklisted = false;

    const adapter = this.createRuntimeAdapter(
      cliType,
      {
        instanceId: instance.id,
        sessionId: newProviderSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        launchMode: instance.launchMode,
        model: instance.currentModel,
        fastMode: instance.fastMode,
        residentClaude: this.residentClaudeForSpawn(instance),
        resume: false,
        forkSession: false,
        mcpConfig: this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
        chromeDevtoolsMcp: this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
        browserGatewayMcp: this.spawnConfigBuilder.getBrowserGatewayMcpOptions(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        nodePlacement: instance.nodePlacement,
        permissionHookPath: this.spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
          rtk: this.spawnConfigBuilder.getRtkSpawnConfig(),
      },
      instance.executionLocation
    );

    this.deps.setupAdapterEvents(instanceId, adapter);
    this.deps.setAdapter(instanceId, adapter);

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      await this.waitForAdapterWritable(instanceId, 3_000);
      if (fallbackHistory) {
        this.prepareStatusForAdapterInput(instance);
        await adapter.sendInput(fallbackHistory);
      }
      instance.recoveryMethod = 'replay';
      return { success: true, method: 'replay-fallback' };
    } catch (error) {
      instance.processId = null;
      if (this.deps.getAdapter(instanceId) === adapter) {
        this.deps.deleteAdapter(instanceId);
      }
      await adapter.terminate(true).catch(() => { /* ignore cleanup failure */ });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ============================================
  // Instance Restart
  // ============================================

  /**
   * Restart an instance
   */
  async restartInstance(instanceId: string): Promise<void> {
    const pendingInstance = this.deps.getInstance(instanceId);
    const release = await getSessionMutex().acquire(instanceId, 'restart', {
      operation: 'restart',
      recoveryReason: 'restart',
      turnId: pendingInstance?.activeTurnId,
      adapterGeneration: pendingInstance?.adapterGeneration,
    });
    try {
      const instance = this.deps.getInstance(instanceId);
      if (!instance) {
        throw new Error(`Instance ${instanceId} not found`);
      }

      logger.info('[RESTART] begin', {
        instanceId,
        preUsed: instance.contextUsage?.used,
        preTotal: instance.contextUsage?.total,
        prePercentage: instance.contextUsage?.percentage,
        providerSessionId: instance.providerSessionId,
        restartCount: instance.restartCount,
        historyThreadId: instance.historyThreadId,
      });

      instance.restartEpoch += 1;
      instance.recoveryMethod = undefined;
      instance.processId = null;
      this.deps.clearPendingState?.(instanceId);
      this.deps.stopStuckTracking?.(instanceId);

      const oldAdapter = this.deps.getAdapter(instanceId);
      if (oldAdapter) {
        try {
          await oldAdapter.terminate(true);
        } catch (error) {
          logger.warn('Adapter terminate failed during restart, proceeding', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      instance.restartCount += 1;
      this.resetTerminalStateForRestart(instance);
      this.transitionState(instance, 'initializing');
      this.deps.queueUpdate(
        instanceId,
        'initializing',
        instance.contextUsage,
        instance.diffStats,
        undefined,
        undefined,
        undefined,
        {
          providerSessionId: instance.providerSessionId,
          restartEpoch: instance.restartEpoch,
          archivedUpToMessageId: instance.archivedUpToMessageId,
          historyThreadId: instance.historyThreadId,
        }
      );

      const recovery = new SessionRecoveryCoordinator({
        nativeResume: (id, sessionId) => this.nativeResumeAfterRestart(id, sessionId),
        replayFallback: (id, sessionId) => this.replayFallbackAfterRestart(id, sessionId),
      });
      const providerSessionId = instance.providerSessionId || instance.sessionId;
      const result = await recovery.recover(instanceId, providerSessionId, {
        reason: 'restart',
        previousAdapterId: oldAdapter?.getName(),
        provider: instance.provider,
        model: instance.currentModel,
        agent: instance.agentId,
        cwd: instance.workingDirectory,
        yolo: instance.yoloMode,
        executionLocation: instance.executionLocation.type,
        capabilities: this.getAdapterRuntimeCapabilities(oldAdapter),
        activeTurnId: instance.activeTurnId,
        adapterGeneration: instance.adapterGeneration ?? 0,
        hasConversation: this.hasActiveConversation(instance),
        sessionResumeBlacklisted: instance.sessionResumeBlacklisted === true,
      });

      if (!result.success) {
        instance.recoveryMethod = 'failed';
        this.transitionState(instance, 'error');
        logger.warn('Restart (resume context) failed; leaving instance in error state', {
          instanceId,
          providerSessionId,
          error: result.error,
        });
        this.deps.queueUpdate(
          instanceId,
          'error',
          instance.contextUsage,
          instance.diffStats,
          undefined,
          undefined,
          undefined,
          {
            providerSessionId: instance.providerSessionId,
            restartEpoch: instance.restartEpoch,
            recoveryMethod: instance.recoveryMethod,
            archivedUpToMessageId: instance.archivedUpToMessageId,
            historyThreadId: instance.historyThreadId,
          }
        );
        return;
      }

      if (instance.status === 'initializing') {
        this.transitionState(
          instance,
          result.method === 'replay-fallback' ? 'busy' : 'idle'
        );
      }
      this.deps.startStuckTracking?.(instanceId);
      this.deps.queueUpdate(
        instanceId,
        instance.status,
        instance.contextUsage,
        result.method === 'replay-fallback' ? null : instance.diffStats,
        undefined,
        undefined,
        undefined,
        {
          providerSessionId: instance.providerSessionId,
          restartEpoch: instance.restartEpoch,
          recoveryMethod: instance.recoveryMethod,
          archivedUpToMessageId: instance.archivedUpToMessageId,
          historyThreadId: instance.historyThreadId,
        }
      );
    } finally {
      release();
    }
  }

  async restartFreshInstance(instanceId: string): Promise<void> {
    const release = await getSessionMutex().acquire(instanceId, 'restart-fresh');
    try {
      const instance = this.deps.getInstance(instanceId);
      if (!instance) {
        throw new Error(`Instance ${instanceId} not found`);
      }

      const cliType = await this.resolveCliTypeForInstance(instance);
      const previousMessages = [...instance.outputBuffer];
      const lastPreFreshMessageId = previousMessages.at(-1)?.id;

      instance.restartEpoch += 1;
      instance.recoveryMethod = undefined;
      instance.processId = null;
      this.deps.clearPendingState?.(instanceId);
      this.deps.stopStuckTracking?.(instanceId);

      const oldAdapter = this.deps.getAdapter(instanceId);
      if (oldAdapter) {
        try {
          await oldAdapter.terminate(true);
        } catch (error) {
          logger.warn('Adapter terminate failed during fresh restart, proceeding', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await this.archiveRestartSnapshot(instance, previousMessages);

      if (lastPreFreshMessageId) {
        instance.archivedUpToMessageId = lastPreFreshMessageId;
        this.deps.addToOutputBuffer(instance, this.createSessionBoundaryMessage());
      } else {
        instance.archivedUpToMessageId = undefined;
      }

      instance.historyThreadId = generateId();
      const newProviderSessionId = generateId();
      instance.providerSessionId = newProviderSessionId;
      instance.sessionId = newProviderSessionId;
      instance.sessionResumeBlacklisted = false;
      this.resetBackendSessionState(instance, cliType, {
        resetTotalTokensUsed: true,
        resetFirstMessageTracking: true,
      });
      const spawnTransaction = createSpawnTransaction(`restart-fresh:${instanceId}`);

      const adapter = this.createRuntimeAdapter(
        cliType,
        {
          instanceId: instance.id,
          sessionId: newProviderSessionId,
          workingDirectory: instance.workingDirectory,
          yoloMode: instance.yoloMode,
          launchMode: instance.launchMode,
          model: instance.currentModel,
          resume: false,
          forkSession: false,
          mcpConfig: this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
          chromeDevtoolsMcp: this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
          browserGatewayMcp: this.spawnConfigBuilder.getBrowserGatewayMcpOptions(
            instance.executionLocation,
            instance.id,
            cliType,
          ) ?? undefined,
          nodePlacement: instance.nodePlacement,
          permissionHookPath: this.spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
          rtk: this.spawnConfigBuilder.getRtkSpawnConfig(),
        },
        instance.executionLocation
      );

      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);
      this.addAdapterRollback(spawnTransaction, instanceId, adapter);

      instance.restartCount += 1;
      this.resetTerminalStateForRestart(instance);
      this.transitionState(instance, 'initializing');
      this.deps.queueUpdate(
        instanceId,
        'initializing',
        instance.contextUsage,
        null,
        undefined,
        undefined,
        undefined,
        {
          providerSessionId: instance.providerSessionId,
          restartEpoch: instance.restartEpoch,
          archivedUpToMessageId: instance.archivedUpToMessageId,
          historyThreadId: instance.historyThreadId,
        }
      );

      try {
        const pid = await adapter.spawn();
        instance.processId = pid;
        await this.waitForInputReadinessBoundary(instanceId, adapter);
        instance.recoveryMethod = 'fresh';
        this.transitionState(instance, 'idle');
        this.deps.startStuckTracking?.(instanceId);
        spawnTransaction.commit();
      } catch (error) {
        await spawnTransaction.rollback(error);
        instance.recoveryMethod = 'failed';
        this.transitionState(instance, 'error');
        logger.error('Failed to restart CLI with fresh context', error instanceof Error ? error : undefined, {
          instanceId,
        });
      }

      this.deps.queueUpdate(
        instanceId,
        instance.status,
        instance.contextUsage,
        null,
        undefined,
        undefined,
        undefined,
        {
          providerSessionId: instance.providerSessionId,
          restartEpoch: instance.restartEpoch,
          recoveryMethod: instance.recoveryMethod,
          archivedUpToMessageId: instance.archivedUpToMessageId,
          historyThreadId: instance.historyThreadId,
        }
      );
    } finally {
      release();
    }
  }

  // ============================================
  // Agent Mode Change
  // ============================================

  /**
   * Change the agent mode for an instance while preserving conversation context
   */
  async changeAgentMode(instanceId: string, newAgentId: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'agent-mode-change');
    try {
      if (instance.status === 'busy') {
        throw new Error('Cannot change agent mode while instance is busy. Please wait for the current operation to complete.');
      }

      if (instance.agentId === newAgentId) {
        return instance;
      }

      // Resolve from registry first (allows markdown-defined agents). Fall back to built-ins for safety.
      const newAgent = await getAgentRegistry().resolveAgent(instance.workingDirectory, newAgentId);
      if (!newAgent) {
        const builtin = getAgentById(newAgentId);
        if (!builtin) throw new Error(`Agent ${newAgentId} not found`);
      }

      const oldAgentId = instance.agentId;
      logger.info('Changing agent mode', { instanceId, oldAgentId, newAgentId });

      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );

      // Terminate existing adapter
      const oldAdapter = this.deps.getAdapter(instanceId);
      const oldAdapterCapabilities = this.getAdapterRuntimeCapabilities(oldAdapter);
      if (oldAdapter) {
        await oldAdapter.terminate(true);
        this.deps.deleteAdapter(instanceId);
      }

      // Update instance with new agent
      instance.agentId = newAgentId;
      instance.agentMode = newAgent.mode;
      this.transitionState(instance, 'initializing');

      // If leaving plan mode, reset plan mode state
      if (instance.planMode.enabled && newAgent.mode !== 'plan') {
        instance.planMode = {
          enabled: false,
          state: 'off',
          planContent: undefined,
          approvedAt: undefined
        };
        logger.info('Auto-exited plan mode due to agent mode change', { instanceId, newAgentId });
      }

      const toolPermissions = buildToolPermissionConfig(newAgent.permissions, {
        allowedToolsPolicy: 'standard-unless-yolo',
        yoloMode: instance.yoloMode,
      });
      attachToolFilterMetadata(instance, toolPermissions.toolFilter);

      const cliType = await this.resolveCliTypeForInstance(instance);
      const shouldResume = hasConversation && oldAdapterCapabilities.supportsResume;
      const shouldForkSession = shouldResume && oldAdapterCapabilities.supportsForkSession;

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : (shouldResume ? instance.sessionId : generateId());
      instance.sessionId = newSessionId;

      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: newSessionId,
        workingDirectory: instance.workingDirectory,
        systemPrompt: newAgent.systemPrompt,
        yoloMode: instance.yoloMode,
        launchMode: instance.launchMode,
        model: instance.currentModel,
        fastMode: instance.fastMode,
        residentClaude: this.residentClaudeForSpawn(instance),
        allowedTools: toolPermissions.allowedTools,
        disallowedTools: toolPermissions.disallowedToolsForSpawn,
        bare: instance.bareMode === true,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
        chromeDevtoolsMcp: this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
        browserGatewayMcp: this.spawnConfigBuilder.getBrowserGatewayMcpOptions(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        nodePlacement: instance.nodePlacement,
        permissionHookPath: this.spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
        rtk: this.spawnConfigBuilder.getRtkSpawnConfig(),
      };

      let adapter = this.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);

      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        let pid: number;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after agent mode change');
          }
          await this.waitForInputReadinessBoundary(instanceId, adapter);
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Failed to spawn with resume, falling back to fresh session', { error: spawnError instanceof Error ? spawnError.message : String(spawnError), instanceId });
            await adapter.terminate(true);

            const fallbackOptions = { ...spawnOptions, resume: false, forkSession: false, sessionId: generateId() };
            instance.sessionId = fallbackOptions.sessionId;
            adapter = this.createRuntimeAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();
            try {
              await getSessionContinuityManager().writeThroughIdentityLocked(instanceId, { sessionId: fallbackOptions.sessionId, resumeCursor: null });
            } catch (err) {
              logger.warn('writeThroughIdentity failed after fresh fallback (agent-mode-change)', {
                instanceId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            await this.waitForInputReadinessBoundary(instanceId, adapter);

            if (hasConversation) {
              this.prepareStatusForAdapterInput(instance);
              await adapter.sendInput(await this.buildFallbackHistory(instance, 'resume-failed-fallback'));
            }
          } else {
            throw spawnError;
          }
        }

        instance.processId = pid;
        this.transitionState(instance, 'idle');
        logger.info('Agent mode changed successfully', { instanceId, newAgentId, pid, resumed: shouldResume });

        if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'agent-mode-change'));
        }

        // Build a mode transition message. When resuming, the system prompt can't be changed,
        // so we send an authoritative message that overrides the previous mode's instructions.
        let modeChangeMessage: string;
        if (oldAgentId === 'plan' && newAgentId !== 'plan') {
          // Explicitly revoke plan mode restrictions since the old system prompt persists in the session
          modeChangeMessage = `[SYSTEM MODE CHANGE - IMPORTANT]
Your mode has been changed from PLAN to ${newAgent.name.toUpperCase()}.
ALL previous PLAN MODE restrictions are now LIFTED. You are NO LONGER in plan mode.
You now have FULL access to: read files, write files, edit files, execute bash commands, and all other tools.
${newAgent.systemPrompt ? `New instructions: ${newAgent.systemPrompt}` : `You are in ${newAgent.name} mode: ${newAgent.description || 'Full access mode.'}`}
Proceed with implementation. Do NOT request to switch modes - you are already in ${newAgent.name} mode.`;
        } else {
          modeChangeMessage = `[System: Agent mode changed to ${newAgent.name}. ${newAgent.description || ''}${newAgent.systemPrompt ? `\n\nNew instructions:\n${newAgent.systemPrompt}` : ''}]`;
        }
        await adapter.sendInput(modeChangeMessage);
      } catch (error) {
        this.transitionState(instance, 'error');
        logger.error('Failed to change agent mode', error instanceof Error ? error : undefined, { instanceId, newAgentId });
        throw error;
      }

      this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      this.emit('agent-changed', {
        instanceId,
        oldAgentId,
        newAgentId,
        agentName: newAgent.name
      });

      return instance;
    } finally {
      release();
    }
  }

  // ============================================
  // YOLO Mode Toggle
  // ============================================

  /**
   * Toggle YOLO mode for an instance while preserving conversation context
   */
  async toggleYoloMode(instanceId: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }
    return this.setYoloMode(instanceId, !instance.yoloMode);
  }

  /** Queue-aware YOLO toggle for the UI. See {@link YoloModeQueue.requestToggle}. */
  async requestYoloModeToggle(instanceId: string): Promise<Instance> {
    return this.yoloQueue.requestToggle(instanceId);
  }

  /**
   * Set YOLO mode for an instance to an explicit target value, respawning the
   * CLI (with resume) so the new permission posture takes effect immediately.
   * No-ops when the instance is already in the desired mode. Throws if the
   * instance is busy, mirroring {@link toggleYoloMode}.
   */
  async setYoloMode(instanceId: string, desiredYoloMode: boolean): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }
    if (instance.yoloMode === desiredYoloMode) {
      // Already in the desired mode — clear any now-satisfied pending request.
      instance.pendingYoloMode = undefined;
      return instance;
    }

    const release = await getSessionMutex().acquire(instanceId, 'yolo-toggle');
    try {
      if (instance.status === 'busy') {
        throw new Error('Cannot change YOLO mode while instance is busy. Please wait for the current operation to complete.');
      }

      const newYoloMode = desiredYoloMode;
      logger.info('Toggling YOLO mode', {
        instanceId,
        currentYoloMode: instance.yoloMode,
        newYoloMode,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });

      // Check if there's actually a conversation to resume
      // If outputBuffer is empty (or only contains system messages), start fresh instead of resuming
      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );
      logger.debug('Checking conversation resume status', {
        instanceId,
        hasConversation,
        outputBufferLength: instance.outputBuffer.length
      });

      // Terminate existing adapter
      const oldAdapter = this.deps.getAdapter(instanceId);
      const oldAdapterCapabilities = this.getAdapterRuntimeCapabilities(oldAdapter);
      if (oldAdapter) {
        logger.debug('Terminating old adapter', { instanceId });
        // Delete from map FIRST to prevent race condition with exit handler
        this.deps.deleteAdapter(instanceId);
        logger.debug('Old adapter deleted from map, now terminating', { instanceId });
        await oldAdapter.terminate(true);
        logger.debug('Old adapter terminated', { instanceId });
      }

      instance.yoloMode = newYoloMode;
      this.transitionState(instance, 'initializing');

      if (newYoloMode) {
        logger.warn('YOLO mode enabled for instance', {
          instanceId: instance.id,
          parentId: instance.parentId,
          provider: instance.provider
        });
      }

      const agent = getAgentById(instance.agentId) || getDefaultAgent();
      const toolPermissions = buildToolPermissionConfig(agent.permissions, {
        allowedToolsPolicy: 'standard-unless-yolo',
        yoloMode: newYoloMode,
      });
      attachToolFilterMetadata(instance, toolPermissions.toolFilter);

      const cliType = await this.resolveCliTypeForInstance(instance);
      const shouldResume = hasConversation && oldAdapterCapabilities.supportsResume;
      const shouldForkSession = shouldResume && oldAdapterCapabilities.supportsForkSession;

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : (shouldResume ? instance.sessionId : generateId());
      instance.sessionId = newSessionId;

      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: newSessionId,
        workingDirectory: instance.workingDirectory,
        systemPrompt: agent.systemPrompt,
        yoloMode: newYoloMode,
        launchMode: instance.launchMode,
        bare: instance.bareMode === true,
        fastMode: instance.fastMode,
        residentClaude: this.residentClaudeForSpawn(instance),
        allowedTools: toolPermissions.allowedTools,
        disallowedTools: toolPermissions.disallowedToolsForSpawn,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
        chromeDevtoolsMcp: this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
        browserGatewayMcp: this.spawnConfigBuilder.getBrowserGatewayMcpOptions(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        nodePlacement: instance.nodePlacement,
        permissionHookPath: this.spawnConfigBuilder.getPermissionHookPath(newYoloMode),
        rtk: this.spawnConfigBuilder.getRtkSpawnConfig(),
      };
      logger.debug('Spawn options configured', {
        instanceId,
        resume: spawnOptions.resume,
        forkSession: spawnOptions.forkSession,
        sessionId: spawnOptions.sessionId
      });

      let adapter = this.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);

      logger.debug('Setting up adapter events', { instanceId });
      this.deps.setupAdapterEvents(instanceId, adapter);
      logger.debug('Storing new adapter', { instanceId });
      this.deps.setAdapter(instanceId, adapter);
      logger.debug('New adapter stored', {
        instanceId,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });

      try {
        logger.debug('Spawning new adapter', { instanceId });
        let pid: number;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after YOLO toggle');
          }
          await this.waitForInputReadinessBoundary(instanceId, adapter);
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Failed to spawn with resume, falling back to fresh session', { error: spawnError instanceof Error ? spawnError.message : String(spawnError), instanceId });
            await adapter.terminate(true);

            // Retry without resume
            const fallbackOptions = { ...spawnOptions, resume: false, forkSession: false, sessionId: generateId() };
            instance.sessionId = fallbackOptions.sessionId;
            adapter = this.createRuntimeAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();
            try {
              await getSessionContinuityManager().writeThroughIdentityLocked(instanceId, { sessionId: fallbackOptions.sessionId, resumeCursor: null });
            } catch (err) {
              logger.warn('writeThroughIdentity failed after fresh fallback (yolo-toggle)', {
                instanceId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            await this.waitForInputReadinessBoundary(instanceId, adapter);

            if (hasConversation) {
              this.prepareStatusForAdapterInput(instance);
              await adapter.sendInput(await this.buildFallbackHistory(instance, 'resume-failed-fallback'));
            }
          } else {
            throw spawnError;
          }
        }

        instance.processId = pid;
        this.transitionState(instance, 'idle');
        logger.info('YOLO mode toggled successfully', { instanceId, pid, newYoloMode, resumed: shouldResume });
        logger.debug('Adapter exists after spawn', { instanceId, adapterExists: !!this.deps.getAdapter(instanceId) });

        if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'yolo-toggle'));
        }

        const modeMessage = newYoloMode
          ? '[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]'
          : '[System: YOLO mode disabled - tool permissions will now require approval.]';
        logger.debug('Sending mode message to adapter', { instanceId, newYoloMode });
        await adapter.sendInput(modeMessage);
        logger.debug('Mode message sent', { instanceId, adapterExists: !!this.deps.getAdapter(instanceId) });
      } catch (error) {
        this.transitionState(instance, 'error');
        logger.error('Failed to toggle YOLO mode', error instanceof Error ? error : undefined, { instanceId, newYoloMode });
        throw error;
      }

      // The live mode now matches; any queued request is satisfied.
      instance.pendingYoloMode = undefined;
      this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      this.emit('yolo-toggled', {
        instanceId,
        yoloMode: newYoloMode,
        pendingYoloMode: instance.pendingYoloMode,
      });

      logger.debug('toggleYoloMode complete', {
        instanceId,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });
      return instance;
    } finally {
      release();
    }
  }

  /**
   * Flip fast mode for an instance. See {@link setFastMode}.
   */
  async toggleFastMode(instanceId: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }
    return this.setFastMode(instanceId, !(instance.fastMode ?? false));
  }

  /**
   * Set fast mode for an instance to an explicit target value. Fast mode is a
   * spawn-level setting for Claude (the `fastMode` settings key, Opus-only) and
   * a per-turn service tier for Codex (`priority`), so applying it to a *running*
   * session means respawning with resume — the same path model/agent/yolo
   * toggles use (via {@link restartInstance}). When no adapter is running yet the
   * next spawn picks the value up from `instance.fastMode`.
   *
   * `options.restart === false` updates the stored preference and notifies
   * listeners WITHOUT respawning — used by the auto-revert path when the provider
   * reports fast mode is unavailable for the current session (it already ran
   * without it, so a restart would be wasteful). No-ops when already in the
   * desired state. Throws if the instance is busy (mirrors {@link setYoloMode}).
   */
  async setFastMode(
    instanceId: string,
    desiredFastMode: boolean,
    options?: { restart?: boolean; reason?: 'user' | 'unavailable' },
  ): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }
    if ((instance.fastMode ?? false) === desiredFastMode) {
      return instance;
    }

    const shouldRestart = options?.restart !== false;
    if (shouldRestart && instance.status === 'busy') {
      throw new Error('Cannot change fast mode while instance is busy. Please wait for the current operation to complete.');
    }

    instance.fastMode = desiredFastMode;
    logger.info('Setting fast mode', {
      instanceId,
      fastMode: desiredFastMode,
      provider: instance.provider,
      reason: options?.reason ?? 'user',
      willRestart: shouldRestart && !!this.deps.getAdapter(instanceId),
    });

    // Apply to a live session by respawning with resume so the new setting takes
    // effect. restartInstance reconstructs spawn options from instance.* (now
    // including fastMode). Skip when no adapter is running — the next spawn reads
    // instance.fastMode directly.
    if (shouldRestart && this.deps.getAdapter(instanceId)) {
      await this.restartInstance(instanceId);
    }

    this.emit('fast-toggled', {
      instanceId,
      fastMode: desiredFastMode,
      reason: options?.reason ?? 'user',
    });
    return instance;
  }

  // ============================================
  // Deferred Permission Resume (delegated to DeferredPermissionHandler)
  // ============================================

  async resumeAfterDeferredPermission(
    instanceId: string, approved: boolean, updatedInput?: Record<string, unknown>, options?: { yoloMode?: boolean },
  ): Promise<void> {
    await this.deferredPermission.resumeAfterDeferredPermission(instanceId, approved, updatedInput, options);
    if (options?.yoloMode !== undefined) {
      // This path forces yolo directly; drop any now-stale queued request.
      const live = this.deps.getInstance(instanceId);
      if (live) live.pendingYoloMode = undefined;
      this.emit('yolo-toggled', { instanceId, yoloMode: options.yoloMode, pendingYoloMode: undefined });
    }
  }

  // ============================================
  // Model Switching
  // ============================================

  /**
   * Change the model for an instance while preserving conversation context.
   * Follows the same pattern as toggleYoloMode: terminate adapter, update state, respawn with resume.
   */
  async changeModel(
    instanceId: string,
    newModel: string,
    reasoningEffort?: Instance['reasoningEffort'] | null,
    modelRuntimeTarget?: Instance['modelRuntimeTarget'],
  ): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'model-change');
    try {
      const unavailableReason = getModelSwitchUnavailableReason(instance.status);
      if (unavailableReason) {
        throw new Error(unavailableReason);
      }

      const oldModel = instance.currentModel || 'default';
      const oldReasoningEffort = instance.reasoningEffort;
      const localModelTarget = modelRuntimeTarget?.kind === 'local-model'
        ? modelRuntimeTarget
        : null;
      const nextReasoningEffort =
        reasoningEffort === undefined
          ? instance.reasoningEffort
          : reasoningEffort ?? undefined;
      logger.info('Changing model', {
        instanceId,
        oldModel,
        newModel,
        oldReasoningEffort,
        nextReasoningEffort,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });

      let nextExecutionLocation = instance.executionLocation;
      if (localModelTarget) {
        await this.assertLocalModelRuntimeAvailable(localModelTarget);
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
      const oldAdapterCapabilities = this.getAdapterRuntimeCapabilities(oldAdapter);
      if (oldAdapter) {
        this.deps.deleteAdapter(instanceId);
        await oldAdapter.terminate(true);
      }

      // Update instance state
      this.transitionState(instance, 'initializing');

      // Resolve agent and permissions (same as toggleYoloMode)
      const agent = getAgentById(instance.agentId) || getDefaultAgent();
      const toolPermissions = buildToolPermissionConfig(agent.permissions, {
        allowedToolsPolicy: 'standard-unless-yolo',
        yoloMode: instance.yoloMode,
      });
      attachToolFilterMetadata(instance, toolPermissions.toolFilter);

      const cliType = await this.resolveCliTypeForInstance(instance);
      // Claude native resume reconnects to the existing provider session, whose
      // model binding can remain the previous model. Use replay continuity for
      // Claude model changes so the fresh process is actually launched with the
      // selected model.
      const shouldResume =
        hasConversation
        && oldAdapterCapabilities.supportsResume
        && cliType !== 'claude'
        && !localModelTarget;
      const shouldForkSession = shouldResume && oldAdapterCapabilities.supportsForkSession;

      // Validate model against provider before passing it
      let validatedModel: string | undefined = localModelTarget?.modelId ?? newModel;
      if (!localModelTarget && isModelTier(newModel)) {
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
          logger.warn('Model not valid for target provider during changeModel, using provider default', {
            model: selection.degradation.requestedModel,
            provider: cliType,
            validModelCount: knownModelIds.length,
            fallbackModel: selection.degradation.fallbackModel ?? 'provider-default',
          });
          this.emitModelSelectionDegradation(instance, selection.degradation);
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
        residentClaude: this.residentClaudeForSpawn(instance),
        allowedTools: toolPermissions.allowedTools,
        disallowedTools: toolPermissions.disallowedToolsForSpawn,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.spawnConfigBuilder.getMcpConfig(instance.executionLocation, instance.id, cliType),
        chromeDevtoolsMcp: this.spawnConfigBuilder.getChromeDevtoolsMcpOptions(instance.executionLocation) ?? undefined,
        browserGatewayMcp: this.spawnConfigBuilder.getBrowserGatewayMcpOptions(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        nodePlacement: instance.nodePlacement,
        permissionHookPath: this.spawnConfigBuilder.getPermissionHookPath(instance.yoloMode),
        rtk: this.spawnConfigBuilder.getRtkSpawnConfig(),
        ...(localModelTarget ? { modelRuntimeTarget: localModelTarget } : {}),
      };

      let adapter = this.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        let pid: number;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after model change');
          }
          await this.waitForInputReadinessBoundary(instanceId, adapter);
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Failed to spawn with resume, falling back to fresh session', { error: spawnError instanceof Error ? spawnError.message : String(spawnError), instanceId });
            await adapter.terminate(true);

            const fallbackOptions = { ...spawnOptions, resume: false, forkSession: false, sessionId: generateId() };
            instance.sessionId = fallbackOptions.sessionId;
            adapter = this.createRuntimeAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();
            try {
              await getSessionContinuityManager().writeThroughIdentityLocked(instanceId, { sessionId: fallbackOptions.sessionId, resumeCursor: null });
            } catch (err) {
              logger.warn('writeThroughIdentity failed after fresh fallback (model-change)', {
                instanceId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            await this.waitForInputReadinessBoundary(instanceId, adapter);

            if (hasConversation) {
              this.prepareStatusForAdapterInput(instance);
              await adapter.sendInput(await this.buildFallbackHistory(instance, 'resume-failed-fallback'));
            }
          } else {
            throw spawnError;
          }
        }

        instance.processId = pid;
        this.transitionState(instance, 'idle');
        logger.info('Model changed successfully', {
          instanceId,
          pid,
          newModel: validatedModel || 'provider-default',
          reasoningEffort: nextReasoningEffort ?? 'provider-default',
          resumed: shouldResume,
        });

        if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'model-change'));
        }

        // Notify the instance about the model change
        await adapter.sendInput(
          `[System: Model changed from ${oldModel} to ${validatedModel || 'provider default'}. Thinking changed from ${oldReasoningEffort ?? 'provider default'} to ${nextReasoningEffort ?? 'provider default'}. Conversation context has been preserved.]`
        );
      } catch (error) {
        this.transitionState(instance, 'error');
        logger.error('Failed to change model', error instanceof Error ? error : undefined, { instanceId, newModel });
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
      );
      this.emit('model-changed', {
        instanceId,
        model: newModel,
        reasoningEffort: nextReasoningEffort,
      });

      return instance;
    } finally {
      release();
    }
  }

  // ============================================
  // Instance Interrupt
  // ============================================

  /**
   * Interrupt an instance (like Ctrl+C) — delegates to InterruptRespawnHandler.
   *
   * When the instance is 'busy', sends SIGINT and transitions to 'respawning'.
   * When the instance is 'respawning' (e.g., second Escape press while stuck),
   * force-terminates the adapter so the frontend can restart cleanly.
   */
  interruptInstance(instanceId: string): boolean {
    return this.interruptRespawn.interrupt(instanceId);
  }

  /**
   * Respawn an instance after interrupt to continue the session
   * (delegates to InterruptRespawnHandler).
   */
  async respawnAfterInterrupt(instanceId: string): Promise<void> {
    return this.interruptRespawn.respawnAfterInterrupt(instanceId);
  }

  /**
   * Respawn an instance after its CLI process exited unexpectedly
   * (delegates to InterruptRespawnHandler).
   *
   * Uses --resume to reconnect to the existing CLI session. Falls back to
   * a fresh session with replay continuity if resume fails.
   */
  async respawnAfterUnexpectedExit(instanceId: string): Promise<void> {
    return this.interruptRespawn.respawnAfterUnexpectedExit(instanceId);
  }

  /**
   * Settle an in-flight interrupt in place when the CLI reports a settled
   * status without exiting (delegates to InterruptRespawnHandler).
   */
  noteInterruptSettled(instanceId: string): void {
    this.interruptRespawn.noteInterruptSettled(instanceId);
  }

  // ============================================
  // Plan Mode Management (delegated to PlanModeManager)
  // ============================================

  enterPlanMode(instanceId: string): Instance {
    return this.planMode.enterPlanMode(instanceId);
  }

  exitPlanMode(instanceId: string, force = false): Instance {
    return this.planMode.exitPlanMode(instanceId, force);
  }

  approvePlan(instanceId: string, planContent?: string): Instance {
    return this.planMode.approvePlan(instanceId, planContent);
  }

  updatePlanContent(instanceId: string, planContent: string): Instance {
    return this.planMode.updatePlanContent(instanceId, planContent);
  }

  getPlanModeState(instanceId: string): {
    enabled: boolean;
    state: string;
    planContent?: string;
  } {
    return this.planMode.getPlanModeState(instanceId);
  }

  // ============================================
  // Instance Rename
  // ============================================

  /**
   * Rename an instance
   */
  renameInstance(instanceId: string, displayName: string): void {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    instance.displayName = displayName;
    instance.isRenamed = true;
    this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage, undefined, displayName);
  }

  // ============================================
  // Idle Instance Management
  // ============================================
  //
  // The periodic check loop, zombie cleanup, and memory-pressure half-terminate
  // live in `./lifecycle/idle-monitor.ts` and are wired up in the constructor.
  // `dispatchRecoveryActions` stays here because it calls `restartInstance`,
  // which is deeply coupled to the lifecycle manager; IdleMonitor invokes it
  // via the `dispatchRecovery` callback.

  /**
   * Read recovery context flags set by recipes and dispatch the corresponding
   * side-effects (respawn, interrupt + prompt injection, etc.).
   */
  private async dispatchRecoveryActions(instanceId: string, failure: DetectedFailure): Promise<void> {
    const ctx = failure.context;

    // requestRespawn — restart the instance (optionally with resume cursor)
    if (ctx['requestRespawn']) {
      logger.info('Recovery action: respawning instance', { instanceId });
      await this.restartInstance(instanceId);
      return; // restart replaces the process — no further actions apply
    }

    // sendInterrupt + injectMessage — interrupt the stuck agent then inject a nudge.
    // A7: Route through the interrupt state machine (not directly to the adapter)
    // so the respawnPromise is set, status transitions are correct, and the nudge
    // message is sent only after the adapter is replaced and ready.
    if (ctx['sendInterrupt']) {
      const interrupted = this.interruptRespawn.interrupt(instanceId);
      const message = ctx['injectMessage'] as string | undefined;
      if (interrupted) {
        if (message) {
          // A7 generation fence: capture respawnPromise IMMEDIATELY after interrupt()
          // returns (before any async resolution can set it to undefined on the
          // instance object).  Even if the promise resolves later and the property is
          // cleared, our local reference remains valid for the await below.
          const instance = this.deps.getInstance(instanceId);
          const respawnPromise = instance?.respawnPromise;
          // Capture interruptSeq so we can abandon the nudge if a subsequent interrupt fires.
          const seqAtInterrupt = getOrCreateTurnSupervisor(instanceId).snapshot().interruptSeq;
          if (respawnPromise) {
            // Await the respawnPromise directly — the force-abort net guarantees
            // it resolves within INTERRUPT_FORCE_ABORT_MS (≤30s), so no separate
            // timeout is needed. A 15s race would fire before the force-abort and
            // return the old (still-registered) adapter from getAdapter(), sending
            // the nudge to the interrupted adapter instead of the fresh one (A7).
            await respawnPromise;
          }
          // interruptSeq fence: if another interrupt fired while we waited, skip the nudge.
          if (!getOrCreateTurnSupervisor(instanceId).isInterruptSeqCurrent(seqAtInterrupt)) {
            logger.info('Recovery action: nudge abandoned — a newer interrupt superseded this one', {
              instanceId,
              capturedSeq: seqAtInterrupt,
            });
          } else {
            // Always re-fetch adapter after the wait (generation fence).
            const freshAdapter = this.deps.getAdapter(instanceId);
            if (freshAdapter) {
              await freshAdapter.sendInput(message);
              logger.info('Recovery action: interrupted and injected message after respawn', { instanceId, message });
            } else {
              logger.warn('Recovery action: no adapter after interrupt/respawn, skipping nudge', { instanceId });
            }
          }
        } else {
          logger.info('Recovery action: interrupted instance via interrupt handler', { instanceId });
        }
      } else {
        logger.warn('Recovery action: interrupt request rejected by state machine', { instanceId });
      }
    }

    // pauseAgent — set instance status so the UI can indicate paused state
    if (ctx['pauseAgent']) {
      const instance = this.deps.getInstance(instanceId);
      if (instance) {
        instance.activityState = 'blocked';
        logger.info('Recovery action: paused agent (set blocked)', { instanceId });
      }
    }
  }

  /**
   * Get memory statistics
   */
  getMemoryStats() {
    return this.memoryPressureMonitor.getStats();
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    this.idleMonitor.stop();
    this.memoryPressureMonitor.stop();
  }
}

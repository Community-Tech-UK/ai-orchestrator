/**
 * Instance Lifecycle Manager - Create, terminate, restart, and mode management
 */

import { EventEmitter } from 'events';
import { app } from 'electron';
import { existsSync } from 'fs';
import * as path from 'path';
import {
  resolveCliType,
  getCliDisplayName,
  type UnifiedSpawnOptions,
  type CliAdapter
} from '../cli/adapters/adapter-factory';
import type { CliType } from '../cli/cli-detection';
import { CopilotCliAdapter } from '../cli/adapters/copilot-cli-adapter';
import type { ResumeAttemptResult } from '../cli/adapters/base-cli-adapter';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import {
  getDefaultModelForCli,
  getModelsForProvider,
  getProviderModelContextWindow,
  isModelTier,
  looksLikeCodexModelId,
  resolveModelForTier
} from '../../shared/types/provider.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { getHistoryManager } from '../history';
import { getMemoryMonitor, getOutputStorageManager } from '../memory';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
import { getCodebaseMiner } from '../memory/codebase-miner';
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
  ContextUsage,
  OutputMessage,
  SessionDiffStats
} from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import type { CoreDeps } from './instance-deps';
import { getPolicyAdapter } from '../observation/policy-adapter';
import { resolveInstructionStack } from '../core/config/instruction-resolver';
import { getHibernationManager } from '../process/hibernation-manager';
import { getSessionContinuityManager } from '../session/session-continuity';
import { getSessionMutex } from '../session/session-mutex';
import { RecoveryRecipeEngine } from '../session/recovery-recipe-engine';
import { createBuiltinRecipes } from '../session/builtin-recovery-recipes';
import { getCheckpointManager } from '../session/checkpoint-manager';
import type { DetectedFailure } from '../../shared/types/error-recovery.types';
import { WarmStartManager } from './warm-start-manager';
import { SessionDiffTracker } from './session-diff-tracker';
import {
  IllegalTransitionError,
  InstanceStateMachine,
} from './instance-state-machine';
import { getAutoTitleService } from './auto-title-service';
import { ActivityStateDetector } from '../providers/activity-state-detector';
import { ensureHookScript } from '../cli/hooks/hook-path-resolver';
import { getDeferDecisionStore } from '../cli/hooks/defer-decision-store';
import { InstanceSpawner } from './lifecycle/instance-spawner';
import { DeferredPermissionHandler } from './lifecycle/deferred-permission-handler';
import { buildInstanceRecord } from './lifecycle/instance-create-builder';
import { PlanModeManager } from './lifecycle/plan-mode-manager';
import { RestartPolicyHelpers } from './lifecycle/restart-policy-helpers';
import {
  SessionRecoveryHandler,
  planSessionRecovery,
  type RecoveryResult,
} from './lifecycle/session-recovery';
import { IdleMonitor } from './lifecycle/idle-monitor';
import { InterruptRespawnHandler } from './lifecycle/interrupt-respawn-handler';
import { RuntimeReadinessCoordinator } from './lifecycle/runtime-readiness';
import { InstanceTerminationCoordinator } from './lifecycle/instance-termination';
import { getCompactionCoordinator } from '../context/compaction-coordinator';
import { getCodemem } from '../codemem';
import { buildCodememMcpConfig } from '../codemem/mcp-config';
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

const logger = getLogger('InstanceLifecycle');
const LOG_PREVIEW_LENGTH = 160;

function summarizeLogText(value: string | undefined, maxLength = LOG_PREVIEW_LENGTH): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
}

function summarizeAttachments(
  attachments: InstanceCreateConfig['attachments']
): Record<string, unknown>[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  return attachments.map((attachment) => ({
    name: summarizeLogText(attachment.name, 80) ?? attachment.name,
    type: attachment.type,
    size: attachment.size,
    dataLength: attachment.data.length,
  }));
}

async function getKnownModelsForCli(cliType: string): Promise<string[]> {
  if (cliType === 'copilot') {
    try {
      const models = await new CopilotCliAdapter().listAvailableModels();
      return models.map(model => model.id);
    } catch (error) {
      logger.warn('Falling back to static Copilot model list during validation', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return getModelsForProvider(cliType).map(model => model.id);
}

function summarizeInitialOutputBuffer(
  outputBuffer: OutputMessage[] | undefined
): Record<string, unknown> | undefined {
  if (!outputBuffer || outputBuffer.length === 0) {
    return undefined;
  }

  const totalContentLength = outputBuffer.reduce((total, message) => total + message.content.length, 0);
  const totalAttachmentCount = outputBuffer.reduce(
    (total, message) => total + (message.attachments?.length ?? 0),
    0
  );

  return {
    count: outputBuffer.length,
    totalContentLength,
    totalAttachmentCount,
    recentMessages: outputBuffer.slice(-3).map((message) => ({
      type: message.type,
      contentLength: message.content.length,
      attachmentCount: message.attachments?.length ?? 0,
      metadataKeys: message.metadata ? Object.keys(message.metadata).slice(0, 8) : undefined,
    })),
  };
}

function summarizeCreateInstanceConfig(config: InstanceCreateConfig): Record<string, unknown> {
  return {
    displayName: config.displayName,
    parentId: config.parentId,
    historyThreadId: config.historyThreadId,
    sessionId: config.sessionId,
    resume: config.resume ?? false,
    workingDirectory: config.workingDirectory,
    initialPromptLength: config.initialPrompt?.length ?? 0,
    initialPromptPreview: summarizeLogText(config.initialPrompt),
    attachments: summarizeAttachments(config.attachments),
    yoloMode: config.yoloMode,
    initialOutputBuffer: summarizeInitialOutputBuffer(config.initialOutputBuffer),
    agentId: config.agentId,
    modelOverride: config.modelOverride,
    provider: config.provider,
    terminationPolicy: config.terminationPolicy,
    hasContextInheritanceOverride: Boolean(config.contextInheritance),
    forceNodeId: config.forceNodeId ?? null,
    hasNodePlacement: Boolean(config.nodePlacement),
  };
}

/**
 * Dependencies required by the lifecycle manager
 */
export interface LifecycleDependencies {
  getInstance: (id: string) => Instance | undefined;
  setInstance: (instance: Instance) => void;
  deleteInstance: (id: string) => boolean;
  getAdapter: (id: string) => CliAdapter | undefined;
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => boolean;
  getInstanceCount: () => number;
  forEachInstance: (callback: (instance: Instance, id: string) => void) => void;
  queueUpdate: (
    instanceId: string,
    status: InstanceStatus,
    contextUsage?: ContextUsage,
    diffStats?: SessionDiffStats | null,
    displayName?: string,
    error?: import('../../shared/types/ipc.types').ErrorInfo,
    executionLocation?: ExecutionLocation,
    sessionState?: {
      providerSessionId?: string;
      restartEpoch?: number;
      adapterGeneration?: number;
      activeTurnId?: string;
      interruptRequestId?: string;
      interruptRequestedAt?: number;
      interruptPhase?: Instance['interruptPhase'];
      lastTurnOutcome?: Instance['lastTurnOutcome'];
      supersededBy?: string;
      cancelledForEdit?: boolean;
      recoveryMethod?: Instance['recoveryMethod'];
      archivedUpToMessageId?: string;
      historyThreadId?: string;
    },
    activityState?: import('../../shared/types/activity.types').ActivityState,
  ) => void;
  serializeForIpc: (instance: Instance) => Record<string, unknown>;
  setupAdapterEvents: (instanceId: string, adapter: CliAdapter) => void;
  initializeRlm: (instance: Instance) => Promise<void>;
  endRlmSession: (instanceId: string) => void;
  ingestInitialOutputToRlm: (instance: Instance, messages: OutputMessage[]) => Promise<void>;
  registerOrchestration: (instanceId: string, workingDirectory: string, parentId: string | null) => void;
  unregisterOrchestration: (instanceId: string) => void;
  markInterrupted: (instanceId: string) => void;
  clearInterrupted: (instanceId: string) => void;
  addToOutputBuffer: (instance: Instance, message: OutputMessage) => void;
  clearFirstMessageTracking: (instanceId: string) => void;
  markFirstMessageReceived: (instanceId: string) => void;
  clearPendingState?: (instanceId: string) => void;
  /** Optional warm-start manager for pre-spawned adapter reuse. */
  warmStartManager?: WarmStartManager;
  /** Optional: store a SessionDiffTracker for the given instance. */
  setDiffTracker?: (id: string, tracker: SessionDiffTracker) => void;
  /** Optional: remove the SessionDiffTracker for the given instance. */
  deleteDiffTracker?: (id: string) => void;
  startStuckTracking?: (instanceId: string) => void;
  stopStuckTracking?: (instanceId: string) => void;
  /** State machine accessors for soft-validated lifecycle transitions. */
  getStateMachine?: (instanceId: string) => InstanceStateMachine | undefined;
  setStateMachine?: (instanceId: string, machine: InstanceStateMachine) => void;
  deleteStateMachine?: (instanceId: string) => void;
  queueInitialPromptForRenderer?: (payload: {
    instanceId: string;
    message: string;
    attachments?: NonNullable<InstanceCreateConfig['attachments']>;
    seededAlready: true;
  }) => void;
  /**
   * Narrow dependency interfaces for the core execution loop.
   * When provided, lifecycle methods should prefer these over direct singleton access.
   * Optional for backward compatibility — existing code paths continue to work.
   */
  coreDeps?: CoreDeps;
}

// MCP config file for spawned CLI instances (LSP server, etc.)
// In packaged app: extraResources places config/ in Contents/Resources/config/
// In dev mode: config/ is at project root, 3 levels up from dist/main/instance/
const MCP_CONFIG_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'config', 'mcp-servers.json')
  : path.resolve(__dirname, '../../../config/mcp-servers.json');

export class InstanceLifecycleManager extends EventEmitter {
  private settings = getSettingsManager();
  private memoryMonitor = getMemoryMonitor();
  private outputStorage = getOutputStorageManager();
  private deps: LifecycleDependencies;
  private activityDetectors = new Map<string, ActivityStateDetector>();
  private recoveryEngine: RecoveryRecipeEngine | null = null;

  /** Extracted runtime readiness / native-resume health checks. */
  private readonly runtimeReadiness: RuntimeReadinessCoordinator;

  /** Extracted termination and cleanup coordinator. */
  private readonly terminator: InstanceTerminationCoordinator;

  /** Extracted idle-monitoring loop (periodic activity poll + zombie cleanup). */
  private readonly idleMonitor: IdleMonitor;

  /** Extracted interrupt + post-interrupt/unexpected-exit respawn flows. */
  private readonly interruptRespawn: InterruptRespawnHandler;

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

  /** Returns MCP config paths to pass to spawned CLI instances.
   *  Returns empty for remote instances — local filesystem paths don't exist on the worker. */
  private getMcpConfig(executionLocation?: ExecutionLocation): string[] {
    // MCP config paths are local filesystem paths. Remote workers have their
    // own MCP config on their filesystem; passing ours would cause invalid
    // --mcp-config arguments that may crash the CLI on the worker.
    if (executionLocation?.type === 'remote') {
      return [];
    }
    const configs: string[] = [];
    try {
      if (existsSync(MCP_CONFIG_PATH)) {
        logger.info('MCP config found', { path: MCP_CONFIG_PATH });
        configs.push(MCP_CONFIG_PATH);
      }
    } catch (err) {
      logger.error('Failed to check MCP config', err instanceof Error ? err : new Error(String(err)), {
        path: MCP_CONFIG_PATH,
      });
    }

    if (this.settings.getAll().codememEnabled) {
      const codememConfig = buildCodememMcpConfig({
        currentDir: __dirname,
        dbPath: path.join(app.getPath('userData'), 'codemem.sqlite'),
        execPath: process.execPath,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      });

      if (codememConfig) {
        configs.push(codememConfig);
      } else {
        logger.warn('Codemem MCP bridge entrypoint not found — child sessions will not expose mcp__codemem__* tools', {
          currentDir: __dirname,
          isPackaged: app.isPackaged,
        });
      }
    }

    if (configs.length === 0) {
      logger.warn('No MCP configs resolved — spawned instances will not have custom MCP servers', {
        expectedPath: MCP_CONFIG_PATH,
        isPackaged: app.isPackaged,
      });
    }

    return configs;
  }

  /** Returns the defer permission hook path for non-YOLO instances, undefined for YOLO.
   *  The hook intercepts dangerous tools (Bash, etc.) and returns `defer` so the
   *  orchestrator can surface approval UI instead of silently denying. */
  private getPermissionHookPath(yoloMode: boolean): string | undefined {
    if (yoloMode) return undefined;
    try {
      return ensureHookScript();
    } catch (err) {
      logger.warn('Failed to resolve defer permission hook path, skipping', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
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

  /**
   * Determine where an instance should execute based on its creation config.
   * Returns { type: 'local' } by default. Only returns remote if:
   * 1. A specific node is forced via forceNodeId, OR
   * 2. Placement preferences match an available remote node
   */
  private resolveExecutionLocation(config: InstanceCreateConfig): ExecutionLocation {
    // 1. Explicit node override
    if (config.forceNodeId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getWorkerNodeRegistry } = require('../remote-node');
        const registry = getWorkerNodeRegistry();
        const node = registry.getNode(config.forceNodeId);
        // Accept both 'connected' and 'degraded' — the UI allows selecting
        // degraded nodes. Silently falling through to local when the user
        // explicitly chose a remote node causes confusing spawn failures
        // (e.g., local Claude CLI tries to use a remote CWD).
        if (node?.status === 'connected' || node?.status === 'degraded') {
          logger.info('Resolved execution location', {
            type: 'remote',
            reason: 'forceNodeId',
            nodeId: config.forceNodeId,
            nodeStatus: node.status,
          });
          return { type: 'remote', nodeId: config.forceNodeId };
        }
        if (config.forceNodeId) {
          logger.warn('Forced nodeId not reachable — falling through to local', {
            nodeId: config.forceNodeId,
            nodeStatus: node?.status ?? 'not-found',
          });
        }
      } catch (err) {
        // Remote node module not available — fall through to local
        logger.warn('Remote node module unavailable', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 2. Placement preferences
    if (config.nodePlacement) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getWorkerNodeRegistry } = require('../remote-node');
        const registry = getWorkerNodeRegistry();
        const node = registry.selectNode(config.nodePlacement);
        if (node) {
          logger.info('Resolved execution location', {
            type: 'remote',
            reason: 'nodePlacement',
            nodeId: node.id,
          });
          return { type: 'remote', nodeId: node.id };
        }
      } catch {
        // Remote node module not available — fall through to local
      }
    }

    // 3. Default: local
    logger.info('Resolved execution location', {
      type: 'local',
      forceNodeId: config.forceNodeId ?? null,
      hasNodePlacement: Boolean(config.nodePlacement),
    });
    return { type: 'local' };
  }

  constructor(deps: LifecycleDependencies) {
    super();
    this.deps = deps;
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
      },
      clearRecoveryHistory: (id) => {
        this.recoveryEngine?.clearHistory(id);
      },
      transitionState: (instance, status) => this.transitionState(instance, status),
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
        getMcpConfig: (loc) => this.getMcpConfig(loc),
        getPermissionHookPath: (yolo) => this.getPermissionHookPath(yolo),
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
        writeDecision: (toolUseId, decision, reason) =>
          getDeferDecisionStore().writeDecision(toolUseId, decision, reason),
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
      queueUpdate: (instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState) =>
        this.deps.queueUpdate(instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState),
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
      queueUpdate: (instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState) =>
        this.deps.queueUpdate(instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState),
      markInterrupted: (id) => this.deps.markInterrupted(id),
      clearInterrupted: (id) => this.deps.clearInterrupted(id),
      addToOutputBuffer: (instance, message) => this.deps.addToOutputBuffer(instance, message),
      setupAdapterEvents: (id, adapter) => this.deps.setupAdapterEvents(id, adapter),
      transitionState: (instance, newState) => this.transitionState(instance, newState),
      getAdapterRuntimeCapabilities: (adapter) => this.getAdapterRuntimeCapabilities(adapter),
      resolveCliTypeForInstance: (instance) => this.resolveCliTypeForInstance(instance),
      getMcpConfig: (loc) => this.getMcpConfig(loc),
      getPermissionHookPath: (yolo) => this.getPermissionHookPath(yolo),
      waitForResumeHealth: (id, timeoutMs) => this.waitForResumeHealth(id, timeoutMs),
      waitForAdapterWritable: (id, timeoutMs) => this.waitForAdapterWritable(id, timeoutMs),
      buildReplayContinuityMessage: (instance, reason) => this.buildReplayContinuityMessage(instance, reason),
      buildFallbackHistory: (instance, reason) => this.buildFallbackHistory(instance, reason),
      emitOutput: (instanceId, message) => { this.emit('output', { instanceId, message }); },
      emitDisplayMarker: (instance, message) => {
        this.deps.addToOutputBuffer(instance, message);
        this.emit('output', { instanceId: instance.id, message });
      },
    });
    this.setupMemoryMonitoring();
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
  }

  private getAdapterRuntimeCapabilities(adapter?: CliAdapter) {
    return this.runtimeReadiness.getAdapterRuntimeCapabilities(adapter);
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
    return getProviderRuntimeService().createAdapter({ cliType, options, executionLocation });
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
  private triggerAutoTitle(instance: Instance, message: string): void {
    getAutoTitleService().maybeGenerateTitle(
      instance.id,
      message,
      (id, title) => {
        logger.debug('Auto-title callback (lifecycle)', { id, title, isRenamed: instance.isRenamed });
        if (!instance.isRenamed) {
          instance.displayName = title;
          this.deps.queueUpdate(id, instance.status, instance.contextUsage, undefined, title);
          getSessionContinuityManager().updateState(id, { displayName: title });
        }
      },
      instance.isRenamed,
    ).catch(() => { /* non-critical */ });
  }

  private async buildFallbackHistory(instance: Instance, reason: string): Promise<string> {
    return this.restartHelpers.buildFallbackHistory(instance, reason);
  }

  private getSeededInitialUserMessage(config: InstanceCreateConfig): OutputMessage | undefined {
    const outputBuffer = config.initialOutputBuffer;
    if (!outputBuffer || outputBuffer.length === 0) {
      return undefined;
    }

    const lastMessage = outputBuffer[outputBuffer.length - 1];
    const expectedAttachmentCount = config.attachments?.length ?? 0;
    const actualAttachmentCount = lastMessage.attachments?.length ?? 0;

    if (
      lastMessage.type === 'user'
      && lastMessage.content === (config.initialPrompt ?? '')
      && actualAttachmentCount === expectedAttachmentCount
    ) {
      return lastMessage;
    }

    return undefined;
  }

  private createInitialUserMessage(config: InstanceCreateConfig): OutputMessage | undefined {
    const hasText = typeof config.initialPrompt === 'string' && config.initialPrompt.length > 0;
    const hasAttachments = Boolean(config.attachments?.length);

    if (!hasText && !hasAttachments) {
      return undefined;
    }

    return {
      id: generateId(),
      timestamp: Date.now(),
      type: 'user',
      content: config.initialPrompt ?? '',
      attachments: config.attachments?.map((attachment) => ({
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        data: attachment.data,
      })),
    };
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

  private async sendInitialPromptWithAttachmentFallback(params: {
    instance: Instance;
    adapter: CliAdapter;
    resolvedCliType: CliType;
    message: string;
    attachments?: InstanceCreateConfig['attachments'];
  }): Promise<void> {
    const { instance, adapter, resolvedCliType, message } = params;
    let attachments = params.attachments;

    try {
      await adapter.sendInput(message, attachments);
      return;
    } catch (initialError) {
      if (isOrchestratorPausedError(initialError)) {
        this.queuePausedInitialPrompt({ instance, message, attachments });
        return;
      }

      if (!attachments?.length || !isUnsupportedOrchestratorAttachmentError(initialError)) {
        throw initialError;
      }

      this.emitAttachmentDropWarnings(instance.id, instance, adapter.getName(), attachments);

      if (!message.trim()) {
        logger.info('Dropped unsupported attachments from attachment-only initial prompt', {
          instanceId: instance.id,
          provider: resolvedCliType,
        });
        return;
      }

      attachments = undefined;
      try {
        await adapter.sendInput(message, attachments);
      } catch (retryError) {
        if (isOrchestratorPausedError(retryError)) {
          this.queuePausedInitialPrompt({ instance, message, attachments });
          return;
        }
        throw retryError;
      }
    }
  }

  private async waitForResumeHealth(
    instanceId: string,
    timeoutMs = 5000,
    pollIntervalMs = 200,
  ): Promise<boolean> {
    const healthy = await this.runtimeReadiness.waitForResumeHealth(instanceId, timeoutMs, pollIntervalMs);
    if (!healthy) {
      return false;
    }

    const resumeResult = this.getAdapterResumeAttemptResult(instanceId);
    if (!resumeResult || resumeResult.source === 'none') {
      return true;
    }

    if (!resumeResult.confirmed) {
      logger.warn('Adapter did not confirm native resume after readiness probe', {
        instanceId,
        source: resumeResult.source,
        requestedSessionId: resumeResult.requestedSessionId,
        actualSessionId: resumeResult.actualSessionId,
        reason: resumeResult.reason,
      });
      return false;
    }

    return true;
  }

  private getAdapterResumeAttemptResult(instanceId: string): ResumeAttemptResult | null {
    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter || typeof (adapter as { getResumeAttemptResult?: unknown }).getResumeAttemptResult !== 'function') {
      return null;
    }

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

    // Initialize state machine for this instance (starts in 'initializing').
    this.deps.setStateMachine?.(instance.id, new InstanceStateMachine('initializing'));

    // If has parent, update parent's children list
    if (instance.parentId) {
      const parent = this.deps.getInstance(instance.parentId);
      if (parent) {
        parent.childrenIds.push(instance.id);
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

    // Emit creation event immediately with 'initializing' status so the UI
    // can render the instance card without waiting for the heavy init below.
    logger.debug('Emitting instance:created event (initializing)', { instanceId: instance.id });
    this.deps.registerOrchestration(
      instance.id,
      instance.workingDirectory,
      instance.parentId
    );
    this.emit('created', this.deps.serializeForIpc(instance));

    // Initial prompts never flow through InstanceManager.sendInput(), so kick
    // off title generation here before the background spawn/send pipeline.
    if (typeof config.initialPrompt === 'string' && config.initialPrompt.trim().length > 0) {
      this.triggerAutoTitle(instance, config.initialPrompt);
    }

    // Restored sessions (history-restore, etc.) arrive with a populated
    // initialOutputBuffer and no initialPrompt. The first real message
    // after restore is a continuation, not a genuine first message — so
    // suppress auto-title re-firing (which would overwrite the restored
    // displayName with a title derived from the follow-up message) and
    // orchestration-prompt re-prepending (which was already applied to
    // the original first message).
    const hasRestoredConversation = config.initialOutputBuffer?.some(
      (msg) => msg.type === 'user' || msg.type === 'assistant'
    ) ?? false;
    const hasInitialPrompt =
      typeof config.initialPrompt === 'string'
      && config.initialPrompt.trim().length > 0;
    if (hasRestoredConversation && !hasInitialPrompt) {
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
      const seededInitialUserMessage = this.getSeededInitialUserMessage(config);
      const initialUserMessage =
        seededInitialUserMessage ?? this.createInitialUserMessage(config);
      try {
        if (signal.aborted) return;

        // Initialize RLM
        await this.deps.initializeRlm(instance);

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

        // Inject observation memory context (learned reflections from past sessions)
        try {
          const observationContext = await getPolicyAdapter().buildObservationContext(
            systemPrompt,
            instance.id,
            config.initialPrompt
          );
          if (observationContext) {
            systemPrompt = `${observationContext}\n\n---\n\n${systemPrompt}`;
            logger.info('Injected observation memory context into system prompt');
          }
        } catch (err) {
          logger.warn('Failed to inject observation context', { error: err instanceof Error ? err.message : String(err) });
        }

        // Inject wake-up context (mempalace L0 identity + L1 essential story)
        if (instance.depth === 0) {
          try {
            const wakeText = getWakeContextBuilder().getWakeUpText(instance.workingDirectory);
            if (wakeText && wakeText.trim().length > 30) {
              systemPrompt = `${wakeText}\n\n---\n\n${systemPrompt}`;
              logger.info('Injected wake-up context into system prompt', {
                tokenEstimate: Math.ceil(wakeText.length / 4),
              });
            }
          } catch (err) {
            logger.warn('Failed to inject wake context', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Trigger codebase mining for the working directory (async, fire-and-forget)
        if (instance.depth === 0 && instance.workingDirectory) {
          getCodebaseMiner().mineDirectory(instance.workingDirectory).catch((err) => {
            logger.warn('Codebase mining failed', {
              error: err instanceof Error ? err.message : String(err),
              workingDirectory: instance.workingDirectory,
            });
          });
        }

        // Append tool permission clarification to prevent models from hallucinating
        // permission issues when commands fail for unrelated reasons (test failures, etc.)
        systemPrompt += '\n\n---\n\n' +
          '[Tool Permissions] Tools available to you are pre-configured for your current mode. ' +
          'Use any tool in your tool list directly without asking the user for permission. ' +
          'If a command fails, it failed for a real reason (syntax error, test failure, missing dependency, etc.) — not because of permissions. ' +
          'Never ask the user to approve or deny tool calls. Just use tools directly.';

        if (signal.aborted) return;

        // Resolve CLI provider type
        const settingsAll = this.settings.getAll();
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

        // Resolve model: explicit override > agent override > settings default
        const settingsModel = settingsAll.defaultModel;
        let resolvedModel = config.modelOverride || resolvedAgent.modelOverride || settingsModel || undefined;

        // Validate model against the target provider's supported models.
        // If the model is a tier name (fast/balanced/powerful), resolve it to a concrete ID.
        // If the model isn't recognized (e.g., a model from another provider), drop it
        // so the provider uses its own default rather than failing with ModelNotFound.
        if (resolvedModel && resolvedCliType !== 'claude') {
          // First: resolve tier names to concrete model IDs
          if (isModelTier(resolvedModel)) {
            const tierResolved = resolveModelForTier(resolvedModel, resolvedCliType);
            logger.info('Resolved model tier to provider-specific model', {
              tier: resolvedModel,
              provider: resolvedCliType,
              resolvedModel: tierResolved || 'provider-default',
            });
            resolvedModel = tierResolved;
          }

          // Then: validate concrete model IDs against the provider's model list
          if (resolvedModel) {
            const providerModels = await getKnownModelsForCli(resolvedCliType);
            if (providerModels.length > 0) {
              const isValid = providerModels.includes(resolvedModel);
              const allowCodexDynamicModel = resolvedCliType === 'codex' && looksLikeCodexModelId(resolvedModel);
              if (!isValid && !allowCodexDynamicModel) {
                const providerDefault = getDefaultModelForCli(resolvedCliType);
                logger.warn('Model not valid for target provider, falling back to provider default', {
                  model: resolvedModel,
                  provider: resolvedCliType,
                  validModels: providerModels,
                  fallbackModel: providerDefault ?? 'none',
                });
                resolvedModel = providerDefault;
              }
            }
          }
        }

        instance.currentModel = resolvedModel;
        instance.contextUsage = {
          ...instance.contextUsage,
          total: getProviderModelContextWindow(resolvedCliType, resolvedModel),
          percentage: 0
        };

        logger.info('Resolved model for instance', {
          configOverride: config.modelOverride,
          agentOverride: resolvedAgent.modelOverride,
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
          reasoningEffort: config.reasoningEffort,
          allowedTools: toolPermissions.allowedTools,
          disallowedTools: toolPermissions.disallowedToolsForSpawn,
          resume: config.resume,
          mcpConfig: this.getMcpConfig(instance.executionLocation),
          permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
        };

        // Check for a pre-warmed adapter before spawning fresh.
        // NEVER use warm-start for resume operations — warm adapters have fresh sessions
        // with no conversation context. Resume requires --resume <sessionId> on a freshly
        // spawned CLI process.
        // NEVER use warm-start for remote sessions — warm adapters are local processes
        // and cannot proxy commands to a remote worker node.
        const warmAdapter = (config.resume || config.forceNodeId || config.nodePlacement)
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

          if (signal.aborted) {
            await adapter.terminate(false).catch(() => { /* ignore */ });
            this.deps.deleteAdapter(instance.id);
            return;
          }

          await this.waitForInputReadinessBoundary(instance.id, adapter);

          // The warm adapter is already spawned; mark the instance as idle.
          this.transitionState(instance, 'idle');
          this.deps.queueUpdate(instance.id, 'idle', instance.contextUsage);
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
                attachments: config.attachments,
              });
            } catch (error) {
              this.transitionState(instance, 'failed');
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error('Failed to send initial prompt via warm adapter', error instanceof Error ? error : undefined, { errorMessage });
              const errorOutput = {
                id: generateId(),
                timestamp: Date.now(),
                type: 'error' as const,
                content: `Failed to initialize ${getCliDisplayName(resolvedCliType)}: ${errorMessage}`
              };
              this.deps.addToOutputBuffer(instance, errorOutput);
              this.emit('output', { instanceId: instance.id, message: errorOutput });
              this.deps.queueUpdate(instance.id, 'failed', instance.contextUsage);
              throw error;
            }
          }
        } else {
          const executionLocation = this.resolveExecutionLocation(config);
          instance.executionLocation = executionLocation;
          // Clear local MCP config for remote instances — paths don't exist on workers
          if (executionLocation.type === 'remote') {
            spawnOptions.mcpConfig = [];
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
            this.deps.queueUpdate(instance.id, 'idle', instance.contextUsage, undefined, undefined, undefined, instance.executionLocation);
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
                attachments: config.attachments,
              });
            }
          } catch (error) {
            this.transitionState(instance, 'failed');
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Failed to spawn/initialize CLI', error instanceof Error ? error : undefined, { errorMessage });

            const errorOutput = {
              id: generateId(),
              timestamp: Date.now(),
              type: 'error' as const,
              content: `Failed to initialize ${getCliDisplayName(resolvedCliType)}: ${errorMessage}`
            };
            this.deps.addToOutputBuffer(instance, errorOutput);
            this.emit('output', { instanceId: instance.id, message: errorOutput });
            this.deps.queueUpdate(instance.id, 'failed', instance.contextUsage);
            throw error;
          }
        }

        // After a successful spawn/warm-start, pre-warm a replacement process in
        // the background for the next createInstance call of the same provider.
        // Skip this after native resume restores: the spare process only serves
        // future fresh sessions, but it still expires on a 5 minute timer while
        // the restored session is idle.
        if (this.deps.warmStartManager && !config.resume) {
          const wsm = this.deps.warmStartManager;
          const warmProvider = resolvedCliType;
          const warmWorkingDir = instance.workingDirectory;
          // Fire and forget — errors are handled inside preWarm.
          void wsm.preWarm(warmProvider, warmWorkingDir);
        } else if (this.deps.warmStartManager && config.resume) {
          logger.info('Skipping warm-start replacement after resumed session spawn', {
            provider: resolvedCliType,
            instanceId: instance.id,
            sessionId: instance.sessionId,
          });
        }

      } catch (error) {
        if (!signal.aborted) {
          if (instance.status !== 'failed') {
            this.transitionState(instance, 'failed');
            this.deps.queueUpdate(instance.id, 'failed', instance.contextUsage);
          }
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
      this.terminateInstance(id, false)
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
          capabilities: {
            supportsResume: Boolean(nativeSessionId) && !sessionState?.nativeResumeFailedAt,
            supportsForkSession: false,
          },
          activeTurnId: instance.activeTurnId,
          adapterGeneration: instance.adapterGeneration ?? 0,
          hasConversation,
          sessionResumeBlacklisted: instance.sessionResumeBlacklisted === true,
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
          model: instance.currentModel,
          resume: canAttemptNativeResume,
          mcpConfig: this.getMcpConfig(instance.executionLocation),
          permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
        };

        let adapter = this.createRuntimeAdapter(cliType, spawnOptions, instance.executionLocation);
        this.deps.setupAdapterEvents(instanceId, adapter);
        this.deps.setAdapter(instanceId, adapter);
        if (this.deps.setDiffTracker) {
          this.deps.setDiffTracker(instanceId, new SessionDiffTracker(instance.workingDirectory));
        }

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
        // Include displayName so the renderer picks up any name restored from session state
        this.deps.queueUpdate(instanceId, 'ready', instance.contextUsage, undefined, instance.displayName);
        logger.info('Instance woken successfully', { instanceId, pid });
      } catch (error) {
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
        model: instance.currentModel,
        resume: true,
        forkSession: false,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
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
        model: instance.currentModel,
        resume: false,
        forkSession: false,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
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

      const recovery = new SessionRecoveryHandler({
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

      const adapter = this.createRuntimeAdapter(
        cliType,
        {
          instanceId: instance.id,
          sessionId: newProviderSessionId,
          workingDirectory: instance.workingDirectory,
          yoloMode: instance.yoloMode,
          model: instance.currentModel,
          resume: false,
          forkSession: false,
          mcpConfig: this.getMcpConfig(instance.executionLocation),
          permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
        },
        instance.executionLocation
      );

      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      instance.restartCount += 1;
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
      } catch (error) {
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
        model: instance.currentModel,
        allowedTools: toolPermissions.allowedTools,
        disallowedTools: toolPermissions.disallowedToolsForSpawn,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
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

    const release = await getSessionMutex().acquire(instanceId, 'yolo-toggle');
    try {
      if (instance.status === 'busy') {
        throw new Error('Cannot toggle YOLO mode while instance is busy. Please wait for the current operation to complete.');
      }

      const newYoloMode = !instance.yoloMode;
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
        allowedTools: toolPermissions.allowedTools,
        disallowedTools: toolPermissions.disallowedToolsForSpawn,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(newYoloMode),
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

      this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      this.emit('yolo-toggled', {
        instanceId,
        yoloMode: newYoloMode
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

  // ============================================
  // Deferred Permission Resume (delegated to DeferredPermissionHandler)
  // ============================================

  async resumeAfterDeferredPermission(
    instanceId: string,
    approved: boolean,
  ): Promise<void> {
    return this.deferredPermission.resumeAfterDeferredPermission(instanceId, approved);
  }

  // ============================================
  // Model Switching
  // ============================================

  /**
   * Change the model for an instance while preserving conversation context.
   * Follows the same pattern as toggleYoloMode: terminate adapter, update state, respawn with resume.
   */
  async changeModel(instanceId: string, newModel: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'model-change');
    try {
      if (instance.status === 'busy') {
        throw new Error('Cannot change model while instance is busy. Please wait for the current operation to complete.');
      }

      const oldModel = instance.currentModel || 'default';
      logger.info('Changing model', {
        instanceId,
        oldModel,
        newModel,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });

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
      const shouldResume = hasConversation && oldAdapterCapabilities.supportsResume;
      const shouldForkSession = shouldResume && oldAdapterCapabilities.supportsForkSession;

      // Validate model against provider before passing it
      let validatedModel: string | undefined = newModel;
      if (cliType !== 'claude') {
        if (isModelTier(newModel)) {
          validatedModel = resolveModelForTier(newModel, cliType);
        }

        const providerModels = getModelsForProvider(cliType);
        const modelToValidate = validatedModel;
        const allowCodexDynamicModel =
          modelToValidate !== undefined &&
          cliType === 'codex' &&
          looksLikeCodexModelId(modelToValidate);
        if (
          modelToValidate !== undefined &&
          providerModels.length > 0 &&
          !providerModels.some(m => m.id === modelToValidate) &&
          !allowCodexDynamicModel
        ) {
          logger.warn('Model not valid for target provider during changeModel, using provider default', {
            model: modelToValidate,
            provider: cliType,
            fallbackModel: 'provider-default',
          });
          validatedModel = undefined;
        }
      }

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : (shouldResume ? instance.sessionId : generateId());
      instance.sessionId = newSessionId;

      instance.currentModel = validatedModel;
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
        allowedTools: toolPermissions.allowedTools,
        disallowedTools: toolPermissions.disallowedToolsForSpawn,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
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
          resumed: shouldResume,
        });

        if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'model-change'));
        }

        // Notify the instance about the model change
        await adapter.sendInput(
          `[System: Model changed from ${oldModel} to ${validatedModel || newModel}. Conversation context has been preserved.]`
        );
      } catch (error) {
        this.transitionState(instance, 'error');
        logger.error('Failed to change model', error instanceof Error ? error : undefined, { instanceId, newModel });
        throw error;
      }

      this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      this.emit('model-changed', {
        instanceId,
        model: newModel
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

    // sendInterrupt + injectMessage — interrupt the stuck agent then inject a nudge
    if (ctx['sendInterrupt']) {
      const adapter = this.deps.getAdapter(instanceId);
      if (adapter) {
        adapter.interrupt();
        const message = ctx['injectMessage'] as string | undefined;
        if (message) {
          // Small delay to let the CLI process the interrupt before we send input
          await new Promise(resolve => setTimeout(resolve, 500));
          await adapter.sendInput(message);
          logger.info('Recovery action: interrupted and injected message', { instanceId, message });
        } else {
          logger.info('Recovery action: interrupted instance', { instanceId });
        }
      } else {
        logger.warn('Recovery action: cannot interrupt — no adapter', { instanceId });
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

  // ============================================
  // Memory Monitoring
  // ============================================

  private setupMemoryMonitoring(): void {
    this.memoryMonitor.on('warning', (stats) => {
      logger.warn('Memory warning', stats as Record<string, unknown>);
      this.emit('memory:warning', stats);
    });

    this.memoryMonitor.on('critical', (stats) => {
      logger.error('Memory critical', undefined, stats as Record<string, unknown>);
      this.emit('memory:critical', stats);

      // Disable warm-start under critical memory pressure to free resources.
      if (this.deps.warmStartManager) {
        logger.info('Disabling warm-start due to critical memory pressure');
        this.deps.warmStartManager.setEnabled(false);
      }

      const settingsAll = this.settings.getAll();
      if (settingsAll.autoTerminateOnMemoryPressure) {
        this.idleMonitor.terminateIdleHalf();
      }
    });

    this.memoryMonitor.on('normal', () => {
      // Re-enable warm-start once pressure returns to normal.
      if (this.deps.warmStartManager) {
        logger.info('Re-enabling warm-start after memory pressure resolved');
        this.deps.warmStartManager.setEnabled(true);
      }
    });

    this.memoryMonitor.on('stats', (stats) => {
      this.emit('memory:stats', stats);
    });

    this.memoryMonitor.start();
  }

  /**
   * Get memory statistics
   */
  getMemoryStats() {
    return {
      process: this.memoryMonitor.getStats(),
      storage: this.outputStorage.getTotalStats(),
      pressureLevel: this.memoryMonitor.getPressureLevel()
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    this.idleMonitor.stop();
    this.memoryMonitor.stop();
  }
}

/**
 * Instance Manager - Coordinator for all CLI instances
 *
 * This is a thin coordinator that delegates to specialized managers:
 * - InstanceStateManager: State, adapters, batch updates
 * - InstanceLifecycleManager: Create, terminate, restart, mode changes
 * - InstanceCommunicationManager: Adapter events, message passing
 * - InstanceContextManager: RLM and unified memory context
 * - InstanceOrchestrationManager: Child spawning, fast-path retrieval
 * - InstancePersistenceManager: Session export, import, storage
 */

import { EventEmitter } from 'events';
import { createHash, randomUUID } from 'node:crypto';
import { getLogger } from '../logging/logger';
import { generateChildPrompt, stripOrchestrationMarkers } from '../orchestration/orchestration-protocol';
import { getCommandManager } from '../commands/command-manager';
import { getSettingsManager } from '../core/config/settings-manager';
import { getTaskManager } from '../orchestration/task-manager';
import { buildChildDiagnosticBundle } from '../orchestration/child-diagnostics';
import { getChildResultStorage } from '../orchestration/child-result-storage';
import type { RoutingDecision } from '../routing';
import type { SpawnChildCommand } from '../orchestration/orchestration-protocol';
import type {
  Instance,
  InstanceCreateConfig,
  InstanceStatus,
  ExportedSession,
  FileAttachment,
  ForkConfig,
  OutputMessage
} from '../../shared/types/instance.types';
import { generateId, generateInstanceId } from '../../shared/utils/id-generator';
import {
  resolveCliType,
  type CliAdapter,
} from '../cli/adapters/adapter-factory';

import { InstanceStateManager } from './instance-state';
import { InstanceLifecycleManager } from './instance-lifecycle';
import { InstanceCommunicationManager } from './instance-communication';
import { InstanceContextManager } from './instance-context';
import { InstanceEventAggregator } from './instance-event-aggregator';
import { InstanceOrchestrationManager } from './instance-orchestration';
import { InstancePersistenceManager } from './instance-persistence';
import { WarmStartManager } from './warm-start-manager';
import { StuckProcessDetector } from './stuck-process-detector';
import { getAutoTitleService } from './auto-title-service';
import { productionCoreDeps } from './instance-deps';
import { getSessionContinuityManager } from '../session/session-continuity';
import { getPermissionEnforcer } from '../security/permission-enforcer';
import { getPermissionManager, type PermissionRequest, type PermissionScope } from '../security/permission-manager';
import {
  getToolExecutionGate,
  type ToolExecutionGateDecision,
} from '../security/tool-execution-gate';
import * as path from 'path';
import type { UserActionRequest } from '../orchestration/orchestration-handler';
import { BaseCliAdapter, type AdapterRuntimeCapabilities } from '../cli/adapters/base-cli-adapter';
import { getCompactionCoordinator } from '../context/compaction-coordinator.js';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import { toProviderOutputEvent } from '../providers/provider-output-event';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { emitPluginHook } from '../plugins/hook-emitter';
import type { PluginRoutingAudit } from '../../shared/types/plugin.types';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { OrchestratorPausedError } from '../pause/orchestrator-paused-error';
import { IPC_CHANNELS } from '@contracts/channels';
import type { WindowManager } from '../window-manager';
import {
  getHistoryRestoreCoordinator,
  type HistoryRestoreCoordinatorOptions,
  type HistoryRestoreCoordinatorResult,
} from '../history/history-restore-coordinator';

const logger = getLogger('InstanceManager');
const LOG_PREVIEW_LENGTH = 160;
const CHILD_STARTUP_TIMEOUT_MS = 60_000;

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

function sanitizeCreateConfig(config: InstanceCreateConfig): Partial<InstanceCreateConfig> {
  const { attachments, initialOutputBuffer, initialPrompt, ...rest } = config;
  return {
    ...rest,
    initialPrompt: initialPrompt ? summarizeLogText(initialPrompt, 240) : undefined,
    attachments: attachments?.map((attachment) => ({
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      data: `[${attachment.size} bytes omitted]`,
    })),
    initialOutputBuffer: initialOutputBuffer
      ? initialOutputBuffer.map((message) => ({
          ...message,
          content: summarizeLogText(message.content, 240) ?? '',
        }))
      : undefined,
  };
}

function summarizeInputRequiredPayload(payload: {
  instanceId: string;
  requestId: string;
  prompt: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = payload.metadata ?? {};
  return {
    instanceId: payload.instanceId,
    requestId: payload.requestId,
    timestamp: payload.timestamp,
    promptLength: payload.prompt.length,
    promptPreview: summarizeLogText(payload.prompt),
    metadataType: typeof metadata['type'] === 'string' ? metadata['type'] : undefined,
    approvalTraceId: typeof metadata['approvalTraceId'] === 'string'
      ? metadata['approvalTraceId']
      : undefined,
    action: typeof metadata['action'] === 'string' ? metadata['action'] : undefined,
    path: typeof metadata['path'] === 'string'
      ? summarizeLogText(metadata['path'])
      : undefined,
    permissionKey: typeof metadata['permissionKey'] === 'string'
      ? metadata['permissionKey']
      : undefined,
  };
}

export class InstanceManager extends EventEmitter {
  // Sub-managers
  private state: InstanceStateManager;
  private lifecycle: InstanceLifecycleManager;
  private communication: InstanceCommunicationManager;
  private context: InstanceContextManager;
  private orchestrationMgr: InstanceOrchestrationManager;
  private persistence: InstancePersistenceManager;
  private warmStart: WarmStartManager;
  private stuckDetector: StuckProcessDetector;
  private lifecycleEvents = new InstanceEventAggregator();

  // Tracking
  private hasReceivedFirstMessage = new Set<string>();
  private settings = getSettingsManager();
  private pendingPermissionRequestsByInputId = new Map<string, PermissionRequest>();
  private providerRuntimeSeqByInstance = new Map<string, number>();
  private readonly handlePause = (): void => {
    this.interruptActiveTurnsForPause();
  };

  constructor(private readonly windowManager?: Pick<WindowManager, 'sendToRenderer'>) {
    super();

    // Initialize the warm-start manager. The spawnAdapter callback creates a
    // fresh adapter for the given provider and immediately spawns it so that
    // the process is ready when the next createInstance() call arrives.
    this.warmStart = new WarmStartManager({
      spawnAdapter: async (provider, options) => {
        const settingsAll = this.settings.getAll();
        const resolvedCliType = await resolveCliType(
          provider as Parameters<typeof resolveCliType>[0],
          settingsAll.defaultCli
        );
        const adapter: CliAdapter = getProviderRuntimeService().createAdapter({
          cliType: resolvedCliType,
          options: {
            workingDirectory: options.workingDirectory,
          },
        });
        await adapter.spawn();
        return adapter;
      },
      killAdapter: async (adapter) => {
        await (adapter as CliAdapter).terminate(false);
      },
    });

    // Initialize sub-managers with dependencies
    this.state = new InstanceStateManager();
    this.context = new InstanceContextManager();
    this.orchestrationMgr = new InstanceOrchestrationManager({
      getInstance: (id) => this.state.getInstance(id),
      getInstanceCount: () => this.state.getInstanceCount(),
      createChildInstance: (parentId, cmd, routing) => this.createChildInstance(parentId, cmd, routing),
      sendInput: (id, msg) => this.sendInput(id, msg),
      terminateInstance: (id, graceful) => this.terminateInstance(id, graceful),
      getAdapter: (id) => this.state.getAdapter(id)
    });
    this.stuckDetector = new StuckProcessDetector({
      isProcessAlive: (id) => {
        const adapter = this.state.getAdapter(id);
        return adapter?.isRunning() ?? false;
      },
      hasExternalActivity: (id) => this.orchestrationMgr.hasActiveWork(id),
    });

    // Communication manager needs dependencies
    this.communication = new InstanceCommunicationManager({
      getInstance: (id) => this.state.getInstance(id),
      getAdapter: (id) => this.state.getAdapter(id),
      setAdapter: (id, adapter) => this.state.setAdapter(id, adapter),
      deleteAdapter: (id) => this.state.deleteAdapter(id),
      transitionState: (instance, status) => this.lifecycle.transitionStatePublic(instance, status),
      queueUpdate: (id, status, ctx, diffStats, displayName, error, executionLocation, sessionState, activityState, currentModel) => (
        this.state.queueUpdate(
          id,
          status,
          ctx,
          diffStats,
          displayName,
          error,
          executionLocation,
          sessionState,
          activityState,
          currentModel,
        )
      ),
      getDiffTracker: (id) => this.state.getDiffTracker(id),
      processOrchestrationOutput: (id, content) => this.orchestrationMgr.processOrchestrationOutput(id, content),
      onInterruptedExit: (id) => this.lifecycle.respawnAfterInterrupt(id),
      onUnexpectedExit: (id) => this.lifecycle.respawnAfterUnexpectedExit(id),
      ingestToRLM: (id, msg) => this.context.ingestToRLM(id, msg),
      ingestToUnifiedMemory: (inst, msg) => this.context.ingestToUnifiedMemory(inst, msg),
      compactContext: async (id) => {
        const instance = this.state.getInstance(id);
        if (instance) {
          // Try native adapter compaction first (e.g., Codex thread/compact/start).
          // This actually reduces the provider's context window usage.
          const adapter = this.state.getAdapter(id);
          if (adapter && 'compactContext' in adapter && typeof (adapter as { compactContext: () => Promise<boolean> }).compactContext === 'function') {
            try {
              const nativeResult = await (adapter as { compactContext: () => Promise<boolean> }).compactContext();
              logger.info('Native adapter compaction attempted', { instanceId: id, success: nativeResult });
            } catch (err) {
              logger.warn('Native adapter compaction failed, continuing with local compaction', {
                instanceId: id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          await this.context.compactContext(id, instance);
        }
      },
      onChildExit: (childId, child, exitCode) => {
        this.handleChildExit(childId, child, exitCode);
      },
      onOutput: (id) => this.stuckDetector.recordOutput(id),
      onToolStateChange: (id, state) => this.stuckDetector.updateState(id, state),
      createSnapshot: (id, name, desc, trigger) => {
        try {
          getSessionContinuityManager().createSnapshot(id, name, desc, trigger);
        } catch {
          // Non-critical — don't fail the operation
        }
      },
      getBudgetTracker: (id) => {
        try {
          return getCompactionCoordinator().getBudgetTracker(id);
        } catch {
          return undefined;
        }
      },
      getContextUsage: (id) => {
        const inst = this.state.getInstance(id);
        return inst?.contextUsage;
      },
      emitProviderRuntimeEvent: (instanceId, event, options) =>
        this.emitProviderRuntimeEvent(instanceId, event, options),
    });

    // Lifecycle manager needs dependencies
    this.lifecycle = new InstanceLifecycleManager({
      getInstance: (id) => this.state.getInstance(id),
      setInstance: (inst) => this.state.setInstance(inst),
      deleteInstance: (id) => this.state.deleteInstance(id),
      getAdapter: (id) => this.state.getAdapter(id),
      setAdapter: (id, adapter) => this.state.setAdapter(id, adapter),
      deleteAdapter: (id) => this.state.deleteAdapter(id),
      setDiffTracker: (id, tracker) => this.state.setDiffTracker(id, tracker),
      deleteDiffTracker: (id) => this.state.deleteDiffTracker(id),
      getInstanceCount: () => this.state.getInstanceCount(),
      forEachInstance: (cb) => this.state.forEachInstance(cb),
      queueUpdate: (id, status, ctx, diffStats, displayName, error, executionLocation, sessionState, activityState, currentModel) => (
        this.state.queueUpdate(
          id,
          status,
          ctx,
          diffStats,
          displayName,
          error,
          executionLocation,
          sessionState,
          activityState,
          currentModel,
        )
      ),
      serializeForIpc: (inst) => this.state.serializeForIpc(inst),
      setupAdapterEvents: (id, adapter) => this.communication.setupAdapterEvents(id, adapter),
      initializeRlm: (inst) => this.context.initializeRlm(inst),
      endRlmSession: (id) => this.context.endRlmSession(id),
      ingestInitialOutputToRlm: (inst, msgs) => this.context.ingestInitialOutputToRlm(inst, msgs),
      registerOrchestration: (id, wd, pid) => this.orchestrationMgr.registerInstance(id, wd, pid),
      unregisterOrchestration: (id) => this.orchestrationMgr.unregisterInstance(id),
      markInterrupted: (id) => this.communication.markInterrupted(id),
      clearInterrupted: (id) => this.communication.clearInterrupted(id),
      addToOutputBuffer: (inst, msg) => this.communication.addToOutputBuffer(inst, msg),
      queueContinuityPreamble: (id, preamble) => this.communication.queueContinuityPreamble(id, preamble),
      clearFirstMessageTracking: (id) => this.hasReceivedFirstMessage.delete(id),
      markFirstMessageReceived: (id) => this.hasReceivedFirstMessage.add(id),
      clearPendingState: (id) => this.clearPendingInteractiveState(id),
      warmStartManager: this.warmStart,
      startStuckTracking: (id) => this.stuckDetector.startTracking(id),
      stopStuckTracking: (id) => this.stuckDetector.stopTracking(id),
      getStateMachine: (id) => this.state.getStateMachine(id),
      setStateMachine: (id, machine) => this.state.setStateMachine(id, machine),
      deleteStateMachine: (id) => this.state.deleteStateMachine(id),
      queueInitialPromptForRenderer: (payload) => this.queueInitialPromptForRenderer(payload),
      coreDeps: (() => { try { return productionCoreDeps(); } catch { return undefined; } })(),
    });

    // Persistence manager needs dependencies
    this.persistence = new InstancePersistenceManager({
      getInstance: (id) => this.state.getInstance(id),
      createInstance: (config) => this.createInstance(config)
    });

    // Wire stuck process detector event handlers
    this.stuckDetector.on('process:suspect-stuck', ({ instanceId, elapsedMs }) => {
      const instance = this.state.getInstance(instanceId);
      if (instance) {
        const secs = Math.round(elapsedMs / 1000);
        const warningMessage: OutputMessage = {
          id: `stuck-warn-${Date.now()}`,
          type: 'system',
          content: `Instance may be stuck — no output for ${secs}s. Will auto-restart if unresponsive.`,
          timestamp: Date.now(),
          metadata: {
            watchdogWarning: true,
            elapsedMs,
          },
        };
        this.communication.addToOutputBuffer(instance, warningMessage);
        this.publishOutput(instanceId, warningMessage);
      }
    });
    this.stuckDetector.on('process:stuck', ({ instanceId }) => {
      this.lifecycle.respawnAfterInterrupt(instanceId).catch(err => {
        logger.error('Failed to respawn stuck process', err instanceof Error ? err : undefined, { instanceId });
      });
    });

    // Set up event forwarding
    this.setupEventForwarding();

    // Set up orchestration handlers
    const settingsAll = this.settings.getAll();
    this.orchestrationMgr.setupOrchestrationHandlers(
      {
        maxTotalInstances: settingsAll.maxTotalInstances,
        maxChildrenPerParent: settingsAll.maxChildrenPerParent,
        allowNestedOrchestration: settingsAll.allowNestedOrchestration,
      },
      (inst, msg) => this.communication.addToOutputBuffer(inst, msg),
      (instanceId, message) => this.publishOutput(instanceId, message),
    );

    // Start periodic task timeout checking
    getTaskManager().startTimeoutChecker(15000, async (timedOut) => {
      for (const task of timedOut) {
        logger.warn('Task timed out', { taskId: task.taskId, childId: task.childId });
        try {
          const orchestration = this.orchestrationMgr.getOrchestrationHandler();
          await orchestration.notifyError(
            task.parentId,
            `Child task "${task.task}" timed out after ${Math.round((task.timeout || 0) / 1000)}s`
          );
        } catch (err) {
          logger.error('Failed to notify parent about timed out task', err instanceof Error ? err : undefined, { parentId: task.parentId, taskId: task.taskId });
        }
      }
    });

    // Listen for settings changes
    this.settings.on('setting-changed', () => {
      const newSettings = this.settings.getAll();
      this.orchestrationMgr.setupOrchestrationHandlers(
        {
          maxTotalInstances: newSettings.maxTotalInstances,
          maxChildrenPerParent: newSettings.maxChildrenPerParent,
          allowNestedOrchestration: newSettings.allowNestedOrchestration,
        },
        (inst, msg) => this.communication.addToOutputBuffer(inst, msg),
        (instanceId, message) => this.publishOutput(instanceId, message),
      );
    });

    getPauseCoordinator().on('pause', this.handlePause);
  }

  // ============================================
  // Event Forwarding
  // ============================================

  private setupEventForwarding(): void {
    // State events
    this.state.on('batch-update', (payload) => this.emit('instance:batch-update', payload));

    // Communication events
    this.communication.on('output', (payload) => this.publishOutput(payload.instanceId, payload.message));
    this.communication.on('input-required', (payload) => {
      logger.info('Input-required event received', summarizeInputRequiredPayload(payload));
      void this.handleInputRequired(payload);
    });

    // Lifecycle events
    this.lifecycle.on('created', (payload) => {
      const instanceId = typeof payload['id'] === 'string' ? String(payload['id']) : null;
      if (instanceId) {
        const instance = this.state.getInstance(instanceId);
        if (instance) {
          this.emit('instance:event', this.lifecycleEvents.recordCreated(instance));
        }
      }
      this.emit('instance:created', payload);
    });
    this.lifecycle.on('removed', (instanceId) => {
      const instance = this.state.getInstance(instanceId);
      this.providerRuntimeSeqByInstance.delete(instanceId);
      this.emit('instance:event', this.lifecycleEvents.recordRemoved(instanceId, instance?.status));
      this.emit('instance:removed', instanceId);
    });
    this.lifecycle.on('output', (payload) => this.publishOutput(payload.instanceId, payload.message));
    this.lifecycle.on('agent-changed', (payload) => this.emit('instance:agent-changed', payload));
    this.lifecycle.on('yolo-toggled', (payload) => this.emit('instance:yolo-toggled', payload));
    this.lifecycle.on('model-changed', (payload) => this.emit('instance:model-changed', payload));
    this.lifecycle.on('state-update', (payload) => {
      this.emit('instance:event', this.lifecycleEvents.recordStateUpdate(payload));
      this.emit('instance:state-update', payload);
    });
    this.lifecycle.on('memory:warning', (stats) => this.emit('memory:warning', stats));
    this.lifecycle.on('memory:critical', (stats) => this.emit('memory:critical', stats));
    this.lifecycle.on('memory:stats', (stats) => this.emit('memory:stats', stats));
  }

  private mapCliPermissionActionToScope(action: string | undefined): PermissionScope {
    const a = (action || '').toLowerCase();
    if (a.includes('read')) return 'file_read';
    if (a.includes('write') || a.includes('edit') || a.includes('create')) return 'file_write';
    if (a.includes('delete') || a.includes('remove')) return 'file_delete';
    if (a.includes('list') || a === 'ls') return 'directory_read';
    return 'tool_use';
  }

  private normalizeRequestedPath(workingDirectory: string, requested: string | undefined): string {
    const p = (requested || '').trim();
    if (!p) return requested || '';
    if (path.isAbsolute(p)) return p;
    if (p.startsWith('./') || p.includes('/') || p.includes('\\')) {
      return path.join(workingDirectory, p);
    }
    return p;
  }

  private getLatestPendingSwitchModeRequest(
    instanceId: string
  ): UserActionRequest | undefined {
    const pending = this.orchestrationMgr
      .getOrchestrationHandler()
      .getPendingUserActionsForInstance(instanceId)
      .filter((request) => request.requestType === 'switch_mode');

    if (pending.length === 0) return undefined;

    return pending.sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  private isAffirmativeApprovalReply(message: string): boolean {
    const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) return false;

    return /^(yes|y|yeah|yep|sure|ok|okay|approved|approve|proceed|continue|go ahead|go for it|do it|sounds good|let'?s do it|switch)$/.test(normalized);
  }

  private isNegativeApprovalReply(message: string): boolean {
    const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) return false;

    return /^(no|n|nope|nah|don'?t|do not|stop|cancel|reject|not now)$/.test(normalized);
  }

  private async maybeHandleSwitchModeReply(
    instanceId: string,
    message: string
  ): Promise<boolean> {
    const pendingRequest = this.getLatestPendingSwitchModeRequest(instanceId);
    if (!pendingRequest) return false;

    const approved = this.isAffirmativeApprovalReply(message);
    const rejected = !approved && this.isNegativeApprovalReply(message);
    if (!approved && !rejected) return false;

    const orchestration = this.orchestrationMgr.getOrchestrationHandler();
    orchestration.respondToUserAction(pendingRequest.id, approved);

    if (approved && pendingRequest.targetMode) {
      await this.changeAgentMode(instanceId, pendingRequest.targetMode);
    }

    const instance = this.state.getInstance(instanceId);
    if (instance) {
      const feedback = approved
        ? pendingRequest.targetMode
          ? `Mode switch approved via chat reply. Switched to ${pendingRequest.targetMode} mode.`
          : 'Action approved via chat reply.'
        : 'Mode switch rejected via chat reply.';

      const systemMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'system',
        content: feedback,
        metadata: {
          source: 'user-action-auto-response',
          requestId: pendingRequest.id,
          requestType: pendingRequest.requestType,
          targetMode: pendingRequest.targetMode,
          approved
        }
      };

      this.communication.addToOutputBuffer(instance, systemMessage);
      this.publishOutput(instanceId, systemMessage);
    }

    return true;
  }

  private async handleInputRequired(payload: {
    instanceId: string;
    requestId: string;
    prompt: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const instance = this.getInstance(payload.instanceId);
    const workingDirectory = instance?.workingDirectory || process.cwd();

    // Ensure project permission rules are available for this directory.
    try {
      getPermissionManager().loadProjectRules(workingDirectory);
    } catch {
      /* intentionally ignored: project rules are optional */
    }

    const meta: Record<string, unknown> = payload.metadata || {};
    const metaType = String(meta['type'] || '');
    const approvalTraceId = typeof meta['approvalTraceId'] === 'string'
      ? String(meta['approvalTraceId'])
      : `approval-manager-${payload.requestId}`;
    let permissionGateDecision: ToolExecutionGateDecision | undefined;
    let permissionGateToolName: string | undefined;
    logger.info('[APPROVAL_TRACE] manager_handle_input_required', {
      approvalTraceId,
      instanceId: payload.instanceId,
      requestId: payload.requestId,
      metadataType: metaType
    });

    // Only gate the known CLI permission denial prompts (Claude CLI emits these for tool_result denial).
    if (metaType === 'permission_denial') {
      const action = meta['action'] as string | undefined;
      const rawPath = meta['path'] as string | undefined;
      const permissionKey = meta['permissionKey'] as string | undefined;
      const toolName = typeof meta['tool_name'] === 'string'
        ? String(meta['tool_name'])
        : (action || 'claude-cli');

      const scope = this.mapCliPermissionActionToScope(action);
      const resource =
        scope.startsWith('file_') || scope.startsWith('directory_')
          ? this.normalizeRequestedPath(workingDirectory, rawPath)
          : `${action || 'access'}:${rawPath || ''}`.trim();

      const request: PermissionRequest = {
        id: `perm-cli-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        instanceId: payload.instanceId,
        scope,
        resource,
        context: {
          toolName: 'claude-cli',
          workingDirectory,
          isChildInstance: Boolean(instance?.parentId),
          depth: instance?.depth ?? 0,
          yoloMode: Boolean(instance?.yoloMode),
        },
        timestamp: Date.now(),
      };

      this.pendingPermissionRequestsByInputId.set(`${payload.instanceId}:${payload.requestId}`, request);
      permissionGateToolName = toolName;
      permissionGateDecision = getToolExecutionGate().evaluate({
        request,
        toolName,
        toolInput: rawPath ? { path: rawPath } : undefined,
      });

      // Rationale: this branch handles tool_result permission denials that Claude CLI
      // already rejected internally (e.g., edits to ~/.claude/settings*.json, which
      // --dangerously-skip-permissions does NOT bypass). Because the CLI has already
      // failed the tool_use, any "Permission granted." reply from the orchestrator is
      // a no-op — `claude-cli-adapter.sendRaw` deliberately doesn't forward it to
      // stdin (the CLI in print-mode isn't awaiting input). Therefore:
      //
      //   - YOLO's auto-allow (no matchedRule) is meaningless here and must NOT
      //     suppress the user-visible prompt; otherwise the user sees nothing while
      //     Claude silently retries the same denied tool_use and gives up.
      //   - Rule-based allow is equally futile — same no-op sendRaw problem.
      //   - Only an explicit matchedRule `deny` should short-circuit silently, since
      //     that represents a deliberate user policy to abandon this kind of action.
      //
      // Everything else (YOLO allow, rule allow, default `ask`) falls through to
      // `emit('instance:input-required', …)` below so the renderer shows the prompt.
      const decision = permissionGateDecision;
      if (decision.action === 'deny') {
        logger.info('[APPROVAL_TRACE] manager_auto_decision', {
          approvalTraceId,
          instanceId: payload.instanceId,
          requestId: payload.requestId,
          decision: decision.action,
          reason: decision.reason,
          source: decision.source,
        });
        this.emitPermissionLifecycleEvent({
          instanceId: payload.instanceId,
          requestId: payload.requestId,
          outcome: 'deny',
          toolName,
          reason: decision.reason,
          source: decision.source,
          metadataType: metaType,
        });
        try {
          await this.sendInputResponse(
            payload.instanceId,
            `Permission denied. (${decision.reason})`,
            permissionKey,
          );
        } catch {
          /* intentionally ignored: auto-response send failure is non-critical */
        }

        // Add an explicit system note so the user isn't left with an unrespondable prompt.
        if (instance) {
          const msg = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system' as const,
            content: `Permission auto-denied for ${toolName}: ${decision.reason}`,
            metadata: {
              permissionDecision: true,
              ...this.toPermissionGateMetadata(decision),
            }
          };
          this.communication.addToOutputBuffer(instance, msg);
          this.publishOutput(payload.instanceId, msg);
        }

        return;
      }
    }

    // Deferred permission requests (defer-based flow): check PermissionManager rules
    // and auto-resume if a rule matches, otherwise forward to renderer.
    if (metaType === 'deferred_permission') {
      const toolName = meta['tool_name'] as string | undefined;
      const toolInput = meta['tool_input'] as Record<string, unknown> | undefined;

      // Build a permission request for the PermissionManager
      const scope: PermissionScope = toolName === 'Bash' ? 'bash_execute' : 'tool_use';
      const resource = toolName === 'Bash' && toolInput?.['command']
        ? `bash:${String(toolInput['command']).substring(0, 200)}`
        : `tool:${toolName || 'unknown'}`;

      const request: PermissionRequest = {
        id: `perm-defer-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        instanceId: payload.instanceId,
        scope,
        resource,
        context: {
          toolName: toolName || 'unknown',
          workingDirectory,
          isChildInstance: Boolean(instance?.parentId),
          depth: instance?.depth ?? 0,
          yoloMode: Boolean(instance?.yoloMode),
        },
        timestamp: Date.now(),
      };

      this.pendingPermissionRequestsByInputId.set(`${payload.instanceId}:${payload.requestId}`, request);
      permissionGateToolName = toolName || 'unknown';
      permissionGateDecision = getToolExecutionGate().evaluate({
        request,
        toolName: toolName || 'unknown',
        toolInput,
      });

      const decision = permissionGateDecision;
      if (decision.action === 'allow' || decision.action === 'deny') {
        logger.info('[APPROVAL_TRACE] manager_auto_decision_deferred', {
          approvalTraceId,
          instanceId: payload.instanceId,
          requestId: payload.requestId,
          decision: decision.action,
          reason: decision.reason,
          toolName,
        });
        this.emitPermissionLifecycleEvent({
          instanceId: payload.instanceId,
          requestId: payload.requestId,
          outcome: decision.action === 'allow' ? 'allow' : 'deny',
          toolName: toolName || 'unknown',
          reason: decision.reason,
          source: decision.source,
          metadataType: metaType,
        });

        // Auto-resume with the decision
        try {
          await this.resumeAfterDeferredPermission(
            payload.instanceId,
            decision.action === 'allow',
          );
        } catch (err) {
          logger.error('Auto-resume after deferred permission failed',
            err instanceof Error ? err : undefined,
            { instanceId: payload.instanceId });
        }

        // Add system note
        if (instance) {
          const msg = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system' as const,
            content: `Permission auto-${decision.action === 'allow' ? 'allowed' : 'denied'} for ${toolName}: ${decision.reason}`,
            metadata: {
              permissionDecision: true,
              ...this.toPermissionGateMetadata(decision),
            }
          };
          this.communication.addToOutputBuffer(instance, msg);
          this.publishOutput(payload.instanceId, msg);
        }

        return;
      }
    }

    // Default behavior: forward to renderer and let the user decide.
    const forwardedPayload = {
      ...payload,
      metadata: {
        ...meta,
        toolGate: permissionGateDecision
          ? this.toPermissionGateMetadata(permissionGateDecision)
          : undefined,
        toolName: permissionGateToolName,
        approvalTraceId,
        traceStage: 'main:instance-manager:forwarded'
      }
    };
    this.emit('instance:input-required', forwardedPayload);
    this.emitPermissionLifecycleEvent({
      instanceId: payload.instanceId,
      requestId: payload.requestId,
      outcome: 'defer',
      toolName: permissionGateToolName,
      reason: permissionGateDecision?.reason ?? 'Awaiting user approval',
      source: permissionGateDecision?.source ?? 'permission-rule',
      metadataType: metaType,
    });
    logger.info('[APPROVAL_TRACE] manager_forward_to_renderer', {
      approvalTraceId,
      instanceId: payload.instanceId,
      requestId: payload.requestId
    });
  }

  recordInputRequiredPermissionDecision(params: {
    instanceId: string;
    requestId: string;
    action: 'allow' | 'deny';
    scope: 'once' | 'session' | 'always';
  }): void {
    const key = `${params.instanceId}:${params.requestId}`;
    const req = this.pendingPermissionRequestsByInputId.get(key);
    if (!req) return;
    this.pendingPermissionRequestsByInputId.delete(key);
    try {
      getPermissionEnforcer().recordUserDecision(params.instanceId, req, params.action, params.scope);
    } catch {
      /* intentionally ignored: recording user decision failure is non-critical */
    }
  }

  clearPendingInputRequiredPermission(instanceId: string, requestId: string): void {
    this.pendingPermissionRequestsByInputId.delete(`${instanceId}:${requestId}`);
  }

  private clearPendingInteractiveState(instanceId: string): void {
    const keyPrefix = `${instanceId}:`;
    for (const key of this.pendingPermissionRequestsByInputId.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.pendingPermissionRequestsByInputId.delete(key);
      }
    }
  }

  private toPermissionGateMetadata(decision: ToolExecutionGateDecision): Record<string, unknown> {
    return {
      action: decision.action,
      reason: decision.reason,
      source: decision.source,
      permissionAction: decision.permission.action,
      permissionReason: decision.permission.reason,
      permissionMode: decision.permission.mode,
      toolPermissionBehavior: decision.toolPermission?.behavior,
      validationErrors: decision.validation?.errors,
      bashRisk: decision.bashValidation?.risk,
      bashMessage: decision.bashValidation?.message,
    };
  }

  private emitPermissionLifecycleEvent(params: {
    instanceId: string;
    requestId: string;
    outcome: 'allow' | 'deny' | 'defer';
    toolName?: string;
    reason: string;
    source: string;
    metadataType: string;
  }): void {
    this.emit('permission:lifecycle', {
      instanceId: params.instanceId,
      requestId: params.requestId,
      outcome: params.outcome,
      toolName: params.toolName,
      reason: params.reason,
      source: params.source,
      metadataType: params.metadataType,
      timestamp: Date.now(),
    });
  }

  private publishOutput(instanceId: string, message: OutputMessage): void {
    this.emitProviderRuntimeEvent(instanceId, toProviderOutputEvent(message));
  }

  private queueInitialPromptForRenderer(payload: {
    instanceId: string;
    message: string;
    attachments?: FileAttachment[];
    seededAlready: true;
  }): void {
    this.emit('instance:queue-initial-prompt', payload);
    this.windowManager?.sendToRenderer(IPC_CHANNELS.INSTANCE_QUEUE_INITIAL_PROMPT, payload);
  }

  private interruptActiveTurnsForPause(): void {
    const activeStatuses = new Set<InstanceStatus>([
      'busy',
      'processing',
      'thinking_deeply',
      'waiting_for_input',
      'waiting_for_permission',
    ]);

    for (const instance of this.state.getAllInstances()) {
      if (!activeStatuses.has(instance.status)) continue;
      try {
        this.lifecycle.interruptInstance(instance.id);
      } catch (error) {
        logger.warn('Failed to interrupt active instance after pause', {
          instanceId: instance.id,
          status: instance.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private emitProviderRuntimeEvent(
    instanceId: string,
    event: ProviderRuntimeEvent,
    options?: {
      provider?: ProviderName;
      sessionId?: string;
      timestamp?: number;
    },
  ): void {
    const instance = this.state.getInstance(instanceId);
    const provider = this.resolveProviderName(instanceId, options?.provider, instance?.provider);
    if (!provider) {
      return;
    }

    const envelope: ProviderRuntimeEventEnvelope = {
      eventId: randomUUID(),
      seq: this.nextProviderRuntimeSeq(instanceId),
      timestamp: options?.timestamp ?? Date.now(),
      provider,
      instanceId,
      sessionId: options?.sessionId ?? instance?.providerSessionId ?? instance?.sessionId,
      adapterGeneration: instance?.adapterGeneration,
      turnId: this.resolveRuntimeEventTurnId(event, instance),
      event,
    };

    this.emit('provider:normalized-event', envelope);
  }

  private resolveRuntimeEventTurnId(
    event: ProviderRuntimeEvent,
    instance?: Instance,
  ): string | undefined {
    if (event.kind === 'output' && typeof event.metadata?.['turnId'] === 'string') {
      return event.metadata['turnId'];
    }

    return instance?.activeTurnId;
  }

  private nextProviderRuntimeSeq(instanceId: string): number {
    const next = this.providerRuntimeSeqByInstance.get(instanceId) ?? 0;
    this.providerRuntimeSeqByInstance.set(instanceId, next + 1);
    return next;
  }

  private resolveProviderName(
    instanceId: string,
    explicitProvider: ProviderName | undefined,
    instanceProvider: Instance['provider'] | undefined,
  ): ProviderName | null {
    if (explicitProvider) {
      return explicitProvider;
    }

    switch (instanceProvider) {
      case 'claude':
      case 'codex':
      case 'gemini':
      case 'copilot':
      case 'cursor':
        return instanceProvider;
      case 'auto':
      case undefined:
        logger.debug('Skipping provider runtime event before provider resolution', { instanceId });
        return null;
      default:
        logger.warn('Unsupported provider for runtime envelope', {
          instanceId,
          provider: instanceProvider,
        });
        return null;
    }
  }

  // ============================================
  // Public API - Instance Access
  // ============================================

  getInstance(id: string): Instance | undefined {
    return this.state.getInstance(id);
  }

  getAllInstances(): Instance[] {
    return this.state.getAllInstances();
  }

  getAllInstancesForIpc(): Record<string, unknown>[] {
    return this.state.getAllInstancesForIpc();
  }

  getInstanceCount(): number {
    return this.state.getInstanceCount();
  }

  /** Return all instances executing on a given worker node */
  getInstancesByNode(nodeId: string): Instance[] {
    return this.state.getAllInstances().filter(
      (i) => i.executionLocation?.type === 'remote' && i.executionLocation.nodeId === nodeId
    );
  }

  getIdleInstances(thresholdMs: number): { id: string; lastActivity: number }[] {
    const now = Date.now();
    return this.state.getAllInstances()
      .filter(i => i.status === 'idle' && (now - i.lastActivity) >= thresholdMs)
      .map(i => ({ id: i.id, lastActivity: i.lastActivity }));
  }

  serializeForIpc(instance: Instance): Record<string, unknown> {
    return this.state.serializeForIpc(instance);
  }

  // ============================================
  // Public API - Instance Lifecycle
  // ============================================

  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    emitPluginHook('instance.spawn.before', {
      parentId: config.parentId ?? null,
      displayName: config.displayName,
      workingDirectory: config.workingDirectory,
      requestedProvider: config.provider,
      requestedModel: config.modelOverride,
      agentId: config.agentId,
      config: sanitizeCreateConfig(config),
      timestamp: Date.now(),
    });

    const instance = await this.lifecycle.createInstance(config);
    const emitAfter = (success: boolean, error?: unknown): void => {
      emitPluginHook('instance.spawn.after', {
        instanceId: instance.id,
        parentId: instance.parentId,
        displayName: instance.displayName,
        workingDirectory: instance.workingDirectory,
        requestedProvider: config.provider,
        requestedModel: config.modelOverride,
        actualProvider: instance.provider,
        actualModel: instance.currentModel,
        agentId: instance.agentId,
        success,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
        timestamp: Date.now(),
      });
    };

    if (instance.readyPromise) {
      instance.readyPromise.then(() => emitAfter(instance.status !== 'failed')).catch((error: unknown) => emitAfter(false, error));
    } else {
      emitAfter(instance.status !== 'failed');
    }

    return instance;
  }

  async restoreFromHistory(
    entryId: string,
    options: HistoryRestoreCoordinatorOptions = {},
  ): Promise<HistoryRestoreCoordinatorResult> {
    return getHistoryRestoreCoordinator().restore(this, entryId, options);
  }

  async terminateInstance(instanceId: string, graceful = true): Promise<void> {
    const instance = this.state.getInstance(instanceId);
    getAutoTitleService().clearInstance(instanceId);
    await this.lifecycle.terminateInstance(instanceId, graceful);
    emitPluginHook('session.terminated', {
      instanceId,
      parentId: instance?.parentId ?? null,
      graceful,
      timestamp: Date.now(),
    });
  }

  async restartInstance(instanceId: string): Promise<void> {
    return this.lifecycle.restartInstance(instanceId);
  }

  async restartFreshInstance(instanceId: string): Promise<void> {
    return this.lifecycle.restartFreshInstance(instanceId);
  }

  async terminateAll(): Promise<void> {
    return this.lifecycle.terminateAll();
  }

  async terminateAllInstances(): Promise<void> {
    return this.lifecycle.terminateAll();
  }

  renameInstance(instanceId: string, displayName: string): void {
    return this.lifecycle.renameInstance(instanceId, displayName);
  }

  async changeAgentMode(instanceId: string, newAgentId: string): Promise<Instance> {
    return this.lifecycle.changeAgentMode(instanceId, newAgentId);
  }

  async toggleYoloMode(instanceId: string): Promise<Instance> {
    return this.lifecycle.toggleYoloMode(instanceId);
  }

  /**
   * Resume a Claude CLI session after the user approves or denies a deferred tool use.
   * Writes the decision to a file, then resumes the CLI with --resume.
   */
  async resumeAfterDeferredPermission(instanceId: string, approved: boolean): Promise<void> {
    return this.lifecycle.resumeAfterDeferredPermission(instanceId, approved);
  }

  async changeModel(instanceId: string, newModel: string): Promise<Instance> {
    return this.lifecycle.changeModel(instanceId, newModel);
  }

  interruptInstance(instanceId: string): boolean {
    return this.lifecycle.interruptInstance(instanceId);
  }

  async hibernateInstance(instanceId: string): Promise<void> {
    return this.lifecycle.hibernateInstance(instanceId);
  }

  async wakeInstance(instanceId: string): Promise<void> {
    return this.lifecycle.wakeInstance(instanceId);
  }

  /**
   * Update an instance's status and broadcast the change.
   * Used by node-failover to mark remote instances as degraded/failed.
   */
  updateInstanceStatus(instanceId: string, status: InstanceStatus, meta?: Record<string, unknown>): void {
    const instance = this.state.getInstance(instanceId);
    if (!instance) {
      logger.warn('updateInstanceStatus: instance not found', { instanceId, status });
      return;
    }

    // Use the lifecycle's transitionState (which validates the state machine)
    this.lifecycle.transitionStatePublic(instance, status);
    this.state.queueUpdate(instanceId, status, instance.contextUsage);

    if (meta) {
      logger.info('Instance status updated', { instanceId, status, ...meta });
    }
  }

  // ============================================
  // Public API - Communication
  // ============================================

  async sendInput(
    instanceId: string,
    message: string,
    attachments?: FileAttachment[],
    options?: { isRetry?: boolean; autoContinuation?: boolean },
  ): Promise<void> {
    const instance = this.state.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError('Instance input refused while orchestrator is paused');
    }

    const inputHookBase = {
      instanceId,
      messageLength: message.length,
      attachmentCount: attachments?.length ?? 0,
    };
    emitPluginHook('instance.input.before', {
      ...inputHookBase,
      messagePreview: summarizeLogText(message, 240) ?? '',
      isRetry: options?.isRetry,
      autoContinuation: options?.autoContinuation,
      timestamp: Date.now(),
    });

    let hookError: string | undefined;
    try {

    // If the instance is still initializing in the background, wait for it to
    // finish before sending any user input. A 30s timeout guards against a
    // hung init process.
    if (instance.readyPromise) {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Instance initialization timed out')), 30_000)
      );
      try {
        await Promise.race([instance.readyPromise, timeoutPromise]);
      } catch (error) {
        instance.abortController?.abort();
        throw error;
      }
      if (instance.status === 'failed') {
        throw new Error('Instance initialization failed');
      }
    }

    // If the instance is respawning after an interrupt, wait for it to finish.
    // This holds the IPC call instead of rejecting, so the renderer's queued
    // message is delivered once the new CLI process is ready.
    if (instance.respawnPromise) {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Instance respawn timed out')), 30_000)
      );
      await Promise.race([instance.respawnPromise, timeoutPromise]);
      if (instance.status === 'error' || instance.status === 'failed') {
        throw new Error('Instance respawn after interrupt failed');
      }
    }

    if (await this.maybeHandleSwitchModeReply(instanceId, message)) {
      return;
    }

    // Resolve slash commands before we do any context budgeting or send to the provider.
    // This keeps UX consistent (user types `/commit`, instance receives the expanded template).
    let resolvedMessage = message;
    let resolvedCommandName: string | undefined;
    let resolvedCommandMeta: {
      executionType: 'prompt' | 'compact' | 'ui';
      model?: string;
      agent?: string;
      subtask?: boolean;
      source?: string;
      uiActionId?: string;
    } | undefined;
    const resolvedCommand = await getCommandManager().executeCommandString(
      message,
      instance.workingDirectory,
    );
    if (resolvedCommand) {
      resolvedCommandName = resolvedCommand.command.name;
      resolvedMessage = resolvedCommand.resolvedPrompt;
      resolvedCommandMeta = {
        executionType: resolvedCommand.execution.type,
        model: resolvedCommand.command.model,
        agent: resolvedCommand.command.agent,
        subtask: resolvedCommand.command.subtask,
        source: resolvedCommand.command.source,
        uiActionId: resolvedCommand.execution.type === 'ui'
          ? resolvedCommand.execution.actionId
          : undefined,
      };
    }

    // Update activity and request count
    instance.requestCount++;
    instance.lastActivity = Date.now();

    // Calculate context budget and build contexts
    const budgets = this.context.calculateContextBudget(instance, resolvedMessage);

    const [rlmContext, unifiedMemoryContext] = await Promise.all([
      this.context.buildRlmContext(instanceId, resolvedMessage, budgets.rlmMaxTokens, budgets.rlmTopK),
      this.context.buildUnifiedMemoryContext(instance, resolvedMessage, generateId(), budgets.unifiedMaxTokens)
    ]);

    if (rlmContext) {
      logger.info('RLM context injected', { instanceId, tokens: rlmContext.tokens, sections: rlmContext.sectionsAccessed.length, durationMs: rlmContext.durationMs });
    }

    if (unifiedMemoryContext) {
      logger.info('UnifiedMemory context injected', { instanceId, tokens: unifiedMemoryContext.tokens, longTermCount: unifiedMemoryContext.longTermCount, proceduralCount: unifiedMemoryContext.proceduralCount, durationMs: unifiedMemoryContext.durationMs });
    }

    // Build metadata for user message
    const metadata: Record<string, unknown> = {};
    if (rlmContext) {
      metadata['rlmContext'] = {
        injected: true,
        tokens: rlmContext.tokens,
        sectionsAccessed: rlmContext.sectionsAccessed,
        durationMs: rlmContext.durationMs,
        source: rlmContext.source
      };
    }
    if (unifiedMemoryContext) {
      metadata['unifiedMemoryContext'] = {
        injected: true,
        tokens: unifiedMemoryContext.tokens,
        longTermCount: unifiedMemoryContext.longTermCount,
        proceduralCount: unifiedMemoryContext.proceduralCount,
        durationMs: unifiedMemoryContext.durationMs
      };
    }

    // Add user message to output buffer
    const userMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'user' as const,
      content: message,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      attachments: attachments?.map((a) => ({
        name: a.name,
        type: a.type,
        size: a.size,
        data: a.data
      }))
    };
    if (resolvedCommandName) {
      userMessage.metadata = {
        ...(userMessage.metadata || {}),
        command: {
          name: resolvedCommandName,
          resolved: true,
          resolvedPromptLength: resolvedMessage.length,
          source: resolvedCommandMeta?.source,
          model: resolvedCommandMeta?.model,
          agent: resolvedCommandMeta?.agent,
          subtask: resolvedCommandMeta?.subtask,
          executionType: resolvedCommandMeta?.executionType,
          uiActionId: resolvedCommandMeta?.uiActionId,
        },
      };
    }
    if (resolvedCommandMeta?.executionType === 'compact') {
      if (!options?.isRetry) {
        this.communication.addToOutputBuffer(instance, userMessage);
        this.publishOutput(instanceId, userMessage);
      }

      await getCompactionCoordinator().compactInstance(instanceId);
      return;
    }

    if (resolvedCommandMeta?.executionType === 'ui') {
      if (!options?.isRetry) {
        this.communication.addToOutputBuffer(instance, userMessage);
        this.publishOutput(instanceId, userMessage);
      }

      this.emitSystemMessage(
        instanceId,
        `Command /${resolvedCommandName} must be executed through the UI command dispatcher.`,
        {
          source: 'command-dispatch',
          commandName: resolvedCommandName,
          uiActionId: resolvedCommandMeta.uiActionId,
        },
      );
      return;
    }

    // If the command requests a subtask (or specifies model/agent), run it in a child instance.
    // This avoids trying to change system prompts/models mid-session.
    const shouldRunAsSubtask =
      !!resolvedCommandName &&
      (resolvedCommandMeta?.subtask === true ||
        !!resolvedCommandMeta?.model ||
        !!resolvedCommandMeta?.agent);
    if (shouldRunAsSubtask) {
      // Emit user message before spawning subtask (subtask path doesn't go through communication.sendInput)
      this.communication.addToOutputBuffer(instance, userMessage);
      this.publishOutput(instanceId, userMessage);
      await this.spawnCommandSubtask(instanceId, resolvedMessage, {
        commandName: resolvedCommandName!,
        model: resolvedCommandMeta?.model,
        agent: resolvedCommandMeta?.agent,
      });
      return;
    }

    // Build context blocks
    const contextBlocks = [
      this.context.formatUnifiedMemoryContextBlock(unifiedMemoryContext),
      this.context.formatRlmContextBlock(rlmContext)
    ].filter(Boolean) as string[];
    let contextBlock = contextBlocks.length > 0 ? contextBlocks.join('\n\n') : null;

    // Prepend orchestration prompt to first message
    if (!this.hasReceivedFirstMessage.has(instanceId)) {
      this.hasReceivedFirstMessage.add(instanceId);
    const orchestrationPrompt = this.orchestrationMgr.getOrchestrationPrompt(instanceId, instance.currentModel);
    const prefix = contextBlock ? `${contextBlock}\n\n` : '';
    contextBlock = `${prefix}${orchestrationPrompt}\n\n---`;

    // Auto-generate a title from the first user message (fire-and-forget)
    getAutoTitleService().maybeGenerateTitle(
      instanceId,
      message,
      (id, title) => {
        logger.debug('Auto-title callback (sendInput)', { id, title, isRenamed: instance.isRenamed });
        if (!instance.isRenamed) {
          instance.displayName = title;
          this.state.queueUpdate(id, instance.status, instance.contextUsage, undefined, title);
          getSessionContinuityManager().updateState(id, { displayName: title });
        }
      },
      instance.isRenamed,
    ).catch(() => { /* non-critical */ });
  }

    // Add user message to output buffer BEFORE sending to CLI.
    // This ensures the user message appears before the AI response in the chat,
    // since sendInput may trigger streaming output that arrives during the await.
    // Skip on retries to avoid duplicate user bubbles in the chat.
    if (!options?.isRetry) {
      this.communication.addToOutputBuffer(instance, userMessage);
      this.publishOutput(instanceId, userMessage);
    }

    await this.communication.sendInput(instanceId, resolvedMessage, attachments, contextBlock, {
      autoContinuation: options?.autoContinuation === true,
    });
    } catch (error) {
      hookError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      emitPluginHook('instance.input.after', {
        ...inputHookBase,
        success: hookError === undefined,
        error: hookError,
        timestamp: Date.now(),
      });
    }
  }

  private async spawnCommandSubtask(
    parentId: string,
    task: string,
    options: { commandName: string; model?: string; agent?: string }
  ): Promise<void> {
    const parent = this.state.getInstance(parentId);
    if (!parent) throw new Error(`Parent instance ${parentId} not found`);

    const spawnCommand: SpawnChildCommand = {
      action: 'spawn_child',
      task,
      name: `/${options.commandName}`,
      agentId: options.agent,
      model: options.model,
      provider: parent.provider,
    };

    const childAgentId = this.orchestrationMgr.resolveChildAgentId(spawnCommand);
    const routingDecision = this.orchestrationMgr.routeChildModel(
      task,
      spawnCommand.model,
      childAgentId,
      spawnCommand.provider,
    );

    // Best-effort notify the user in the UI that we spawned a subtask.
    const systemNote = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system' as const,
      content: `Running /${options.commandName} as a subtask (agent: ${options.agent || 'auto'}, model: ${routingDecision.model}).`,
      metadata: { source: 'command-subtask', commandName: options.commandName, model: routingDecision.model, agent: options.agent },
    };
    this.communication.addToOutputBuffer(parent, systemNote);
    this.publishOutput(parentId, systemNote);

    // Create a child instance directly (same internal mechanics as orchestrator-driven spawning).
    // This intentionally does not reference external repos; it uses our own child prompt format.
    const tempChildId = generateInstanceId();
    const childPrompt = generateChildPrompt(tempChildId, parentId, spawnCommand.task);

    const resolvedProvider =
      spawnCommand.provider ||
      parent.provider ||
      'auto';
    const routingAudit: PluginRoutingAudit = {
      requestedProvider: spawnCommand.provider,
      requestedModel: spawnCommand.model,
      actualProvider: resolvedProvider,
      actualModel: routingDecision.model,
      routingSource: spawnCommand.model || spawnCommand.provider ? 'explicit' : 'parent',
      reason: routingDecision.reason,
    };

    // Tag seeded messages so handleChildExit can distinguish them from the
    // child's own output when auto-capturing a result. Without this tag, the
    // child's "last assistant" message could be one of the parent's messages
    // we copied in for context — producing an echo-back result.
    const seededOutputBuffer = parent.outputBuffer.slice(-50).map((msg) => ({
      ...msg,
      metadata: { ...(msg.metadata ?? {}), seededFromParent: true },
    }));

    const child = await this.createInstance({
      workingDirectory: parent.workingDirectory,
      displayName: spawnCommand.name || `Child of ${parent.displayName}`,
      parentId,
      initialPrompt: childPrompt,
      yoloMode: false,
      agentId: childAgentId,
      modelOverride: routingDecision.model,
      provider: resolvedProvider,
      initialOutputBuffer: seededOutputBuffer,
      metadata: {
        orchestration: {
          role: 'worker',
          parentId,
          commandName: options.commandName,
          task,
          routingAudit,
        },
      },
    });
    this.armChildStartupWatchdog(parentId, child.id, CHILD_STARTUP_TIMEOUT_MS);
  }

  async sendInputResponse(instanceId: string, response: string, permissionKey?: string): Promise<void> {
    // Clear any stored permission request mapping for this input if present.
    // (requestId is only available in IPC payload; best-effort cleanup is done in IPC handler too.)
    return this.communication.sendInputResponse(instanceId, response, permissionKey);
  }

  /**
   * Append a message to the instance output stream and publish the canonical
   * provider runtime envelope.
   */
  emitOutputMessage(instanceId: string, message: OutputMessage): void {
    const instance = this.state.getInstance(instanceId);
    if (!instance) return;
    this.communication.addToOutputBuffer(instance, message);
    this.publishOutput(instanceId, message);
  }

  /**
   * Append a system-level message to the instance's output buffer and publish
   * it through the canonical provider runtime pipeline. Used by orchestration
   * flows (permission grants, policy notices) that run outside the normal
   * CLI-driven output path.
   */
  emitSystemMessage(
    instanceId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    const instance = this.state.getInstance(instanceId);
    if (!instance) return;
    const msg = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system' as const,
      content,
      ...(metadata ? { metadata } : {}),
    };
    this.emitOutputMessage(instanceId, msg);
  }

  queueContinuityPreamble(instanceId: string, preamble: string): void {
    this.communication.queueContinuityPreamble(instanceId, preamble);
  }

  /**
   * Respawn the CLI for an instance using the same resume-or-fresh logic that
   * fires when a process dies unexpectedly. Exposed publicly so orchestration
   * flows (e.g. self-healing permission grants that require the CLI to re-read
   * `~/.claude/settings.json`) can force a reconnect without losing replay
   * continuity. Delegates to the private `lifecycle` manager.
   */
  async respawnAfterUnexpectedExit(instanceId: string): Promise<void> {
    return this.lifecycle.respawnAfterUnexpectedExit(instanceId);
  }

  // ============================================
  // Public API - Plan Mode
  // ============================================

  enterPlanMode(instanceId: string): Instance {
    return this.lifecycle.enterPlanMode(instanceId);
  }

  exitPlanMode(instanceId: string, force = false): Instance {
    return this.lifecycle.exitPlanMode(instanceId, force);
  }

  approvePlan(instanceId: string, planContent?: string): Instance {
    return this.lifecycle.approvePlan(instanceId, planContent);
  }

  updatePlanContent(instanceId: string, planContent: string): Instance {
    return this.lifecycle.updatePlanContent(instanceId, planContent);
  }

  getPlanModeState(instanceId: string): { enabled: boolean; state: string; planContent?: string } {
    return this.lifecycle.getPlanModeState(instanceId);
  }

  // ============================================
  // Public API - Persistence
  // ============================================

  async forkInstance(config: ForkConfig): Promise<Instance> {
    const forked = await this.persistence.forkInstance(config);
    const source = this.state.getInstance(config.instanceId);
    if (source && config.supersedeSource === true) {
      await this.supersedeSourceAfterEditFork(source, forked.id);
    }
    return forked;
  }

  private async supersedeSourceAfterEditFork(source: Instance, forkedInstanceId: string): Promise<void> {
    source.supersededBy = forkedInstanceId;
    source.cancelledForEdit = true;
    source.lastTurnOutcome = 'cancelled';
    source.lastActivity = Date.now();

    if (source.status !== 'superseded' && source.status !== 'terminated' && source.status !== 'failed') {
      this.lifecycle.transitionStatePublic(source, 'superseded');
    }

    const sourceAdapter = this.state.getAdapter(source.id);
    if (sourceAdapter) {
      this.state.deleteAdapter(source.id);
      sourceAdapter.removeAllListeners();
      try {
        await sourceAdapter.terminate(false);
      } catch (error) {
        logger.warn('Failed to terminate superseded source adapter after edit fork', {
          instanceId: source.id,
          forkedInstanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      source.processId = null;
    }

    this.state.queueUpdate(
      source.id,
      source.status,
      source.contextUsage,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        supersededBy: source.supersededBy,
        cancelledForEdit: source.cancelledForEdit,
        adapterGeneration: source.adapterGeneration,
        activeTurnId: source.activeTurnId,
        lastTurnOutcome: source.lastTurnOutcome,
      }
    );
  }

  exportSession(instanceId: string): ExportedSession {
    return this.persistence.exportSession(instanceId);
  }

  exportSessionMarkdown(instanceId: string): string {
    return this.persistence.exportSessionMarkdown(instanceId);
  }

  async importSession(session: ExportedSession, workingDirectory?: string): Promise<Instance> {
    return this.persistence.importSession(session, workingDirectory);
  }

  async loadHistoricalOutput(instanceId: string, limit?: number): Promise<OutputMessage[]> {
    return this.persistence.loadHistoricalOutput(instanceId, limit);
  }

  getInstanceStorageStats(instanceId: string) {
    return this.persistence.getInstanceStorageStats(instanceId);
  }

  // ============================================
  // Public API - Orchestration
  // ============================================

  getOrchestrationHandler() {
    return this.orchestrationMgr.getOrchestrationHandler();
  }

  // ============================================
  // Public API - Memory
  // ============================================

  getMemoryStats() {
    return this.lifecycle.getMemoryStats();
  }

  getAdapter(instanceId: string): CliAdapter | undefined {
    return this.state.getAdapter(instanceId);
  }

  getAdapterRuntimeCapabilities(instanceId: string): AdapterRuntimeCapabilities | null {
    const adapter = this.state.getAdapter(instanceId);
    if (!adapter || !(adapter instanceof BaseCliAdapter)) {
      return null;
    }
    return adapter.getRuntimeCapabilities();
  }

  // ============================================
  // Internal - Child Instance Creation
  // ============================================

  private async createChildInstance(
    parentId: string,
    command: SpawnChildCommand,
    routingDecision: RoutingDecision
  ): Promise<Instance> {
    const parent = this.state.getInstance(parentId);
    if (!parent) {
      throw new Error(`Parent instance ${parentId} not found`);
    }

    const tempChildId = generateInstanceId();

    // Extract parent context (limited to reduce token overhead for children)
    // Strip orchestration markers to prevent children from echoing parent commands
    const parentContextMessages = parent.outputBuffer
      .slice(-10)
      .filter((msg) => msg.type === 'assistant' || msg.type === 'user' || msg.type === 'tool_result')
      .map((msg) => {
        const prefix = msg.type === 'assistant' ? '[Assistant]' : msg.type === 'user' ? '[User]' : '[Tool Result]';
        const rawContent = msg.content.length > 500 ? msg.content.substring(0, 500) + '...[truncated]' : msg.content;
        const content = stripOrchestrationMarkers(rawContent);
        return content ? `${prefix} ${content}` : '';
      })
      .filter((msg) => msg.length > 0);
    const parentContext = parentContextMessages.length > 0 ? parentContextMessages.join('\n\n') : undefined;

    const childPrompt = generateChildPrompt(
      tempChildId,
      parentId,
      command.task,
      undefined,
      parentContext
    );

    const childAgentId = this.orchestrationMgr.resolveChildAgentId(command);

    // Resolve provider
    const commandProvider = command.provider;
    const resolvedProvider =
      commandProvider ||
      parent.provider ||
      'auto';
    const routingAudit: PluginRoutingAudit = {
      requestedProvider: command.provider,
      requestedModel: command.model,
      actualProvider: resolvedProvider,
      actualModel: routingDecision.model,
      routingSource: command.model || command.provider ? 'explicit' : parent.provider ? 'parent' : 'auto',
      reason: routingDecision.reason,
    };

    // Pass relevant parent output to child for RLM indexing (limited for short-lived children)
    // Strip orchestration markers to prevent children from seeing parent commands.
    // Tag seeded messages so handleChildExit can distinguish them from the child's
    // own output when auto-capturing a result (otherwise a child that produces no
    // output would have its "last assistant" message resolve to one of the parent's
    // messages we copied in — producing an echo-back result).
    const initialOutputForChild = parent.outputBuffer
      .slice(-20)
      .filter((msg) => msg.type === 'assistant' || msg.type === 'user' || msg.type === 'tool_result')
      .map((msg) => ({
        ...msg,
        content: stripOrchestrationMarkers(msg.content),
        metadata: { ...(msg.metadata ?? {}), seededFromParent: true },
      }))
      .filter((msg) => msg.content.length > 0);

    // Inherit execution location from parent so children of remote sessions
    // also run on the same remote node (they share the same working directory
    // and filesystem, which only exists on that node).
    const forceNodeId = parent.executionLocation?.type === 'remote'
      ? parent.executionLocation.nodeId
      : undefined;

    const child = await this.createInstance({
      workingDirectory: command.workingDirectory || parent.workingDirectory,
      displayName: command.name || `Child of ${parent.displayName}`,
      parentId: parentId,
      initialPrompt: childPrompt,
      yoloMode: command.yoloMode === true,
      agentId: childAgentId,
      modelOverride: routingDecision.model,
      provider: resolvedProvider,
      initialOutputBuffer: initialOutputForChild,
      forceNodeId,
      metadata: {
        orchestration: {
          role: 'worker',
          parentId,
          task: command.task,
          spawnPromptHash: createHash('sha256').update(command.task).digest('hex'),
          routingAudit,
        },
      },
    });

    // Mark this child as already having received its first message
    this.hasReceivedFirstMessage.add(child.id);
    this.armChildStartupWatchdog(parentId, child.id, CHILD_STARTUP_TIMEOUT_MS);

    return child;
  }

  private armChildStartupWatchdog(parentId: string, childId: string, timeoutMs: number): void {
    const timer = setTimeout(() => {
      void this.failInitializingChild(parentId, childId, timeoutMs);
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    const child = this.state.getInstance(childId);
    child?.readyPromise?.catch(() => {
      clearTimeout(timer);
      void this.notifyFailedChildStartup(parentId, childId);
    });
  }

  private async failInitializingChild(
    parentId: string,
    childId: string,
    timeoutMs: number,
  ): Promise<void> {
    const child = this.state.getInstance(childId);
    if (!child || child.parentId !== parentId) {
      return;
    }

    if (child.status === 'failed' || child.status === 'error') {
      await this.handleChildExit(childId, child, 1);
      return;
    }

    if (child.status !== 'initializing') {
      return;
    }

    child.abortController?.abort();

    const provider = child.provider && child.provider !== 'auto'
      ? child.provider
      : 'selected provider';
    const seconds = Math.round(timeoutMs / 1000);
    const message: OutputMessage = {
      id: `child-startup-timeout-${Date.now()}-${childId.slice(-6)}`,
      timestamp: Date.now(),
      type: 'error',
      content: `Child startup timed out after ${seconds}s while starting ${provider}. The provider CLI did not finish session initialization.`,
      metadata: {
        source: 'child-startup-watchdog',
        parentId,
        timeoutMs,
      },
    };

    this.communication.addToOutputBuffer(child, message);
    this.publishOutput(childId, message);

    try {
      this.lifecycle.transitionStatePublic(child, 'failed');
      this.state.queueUpdate(childId, 'failed', child.contextUsage);
    } catch (error) {
      logger.warn('Failed to mark child startup timeout as failed', {
        childId,
        parentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.handleChildExit(childId, child, 1);
  }

  private async notifyFailedChildStartup(parentId: string, childId: string): Promise<void> {
    const child = this.state.getInstance(childId);
    if (
      !child
      || child.parentId !== parentId
      || (child.status !== 'failed' && child.status !== 'error')
    ) {
      return;
    }

    await this.handleChildExit(childId, child, 1);
  }

  // ============================================
  // Child Exit Handling
  // ============================================

  /**
   * Handle a child instance exiting - notify parent, capture results, clean up tasks.
   * This fixes the issue where children could exit without the parent ever knowing.
   *
   * Flow:
   *   1. Auto-capture result if child didn't use report_result
   *   2. Get child summary from storage
   *   3. Add a system notification to parent's UI output buffer
   *   4. Call notifyChildTerminated with result data → injects to parent CLI
   *   5. If remainingChildren === 0, gather all completed summaries → synthesis prompt
   */
  private async handleChildExit(childId: string, child: Instance, exitCode: number | null): Promise<void> {
    if (!child.parentId) return;

    const orchestration = this.orchestrationMgr.getOrchestrationHandler();
    const taskManager = getTaskManager();
    const storage = getChildResultStorage();

    // 1. Auto-capture result from output buffer if child didn't report one itself.
    // ALWAYS persist a summary (even if buffer is empty) so synthesis never sees
    // "No summary available" for a child that simply produced no output.
    // Filter out messages tagged seededFromParent — those are parent messages we
    // copied in for context, not the child's own output. Without this filter,
    // a child that produced no output would echo back one of the parent's messages.
    if (!storage.hasResult(childId)) {
      const task = taskManager.getTaskByChildId(childId);
      const isOwn = (m: { metadata?: Record<string, unknown> }): boolean =>
        !m.metadata?.['seededFromParent'];
      const lastAssistant = [...child.outputBuffer]
        .reverse()
        .find((m) => m.type === 'assistant' && isOwn(m));
      // If there's no assistant message, fall back to the last error message —
      // this happens with non-Claude providers (e.g. Gemini/Copilot) when a
      // tool call fails silently and the adapter never produces a synthesized
      // assistant reply. Using the error text gives the parent an actionable
      // summary instead of an unhelpful "Child exited without producing any
      // output." that hides the real cause.
      const lastError = lastAssistant
        ? undefined
        : [...child.outputBuffer]
            .reverse()
            .find((m) => m.type === 'error' && isOwn(m));
      const summary = lastAssistant
        ? lastAssistant.content.substring(0, 500)
        : lastError
          ? `Child errored before producing a reply: ${lastError.content.substring(0, 500)}`
          : 'Child exited without producing any output.';
      const success = exitCode === 0 && lastAssistant !== undefined;

      try {
        await storage.storeFromOutputBuffer(
          childId,
          child.parentId,
          task?.task || child.displayName,
          summary,
          success,
          child.outputBuffer,
          child.createdAt
        );
      } catch (err) {
        logger.error('Failed to auto-capture result for child', err instanceof Error ? err : undefined, { childId });
      }
    }

    // 2. Get child summary for both UI notification and CLI injection
    let childSummaryData: {
      resultId: string;
      summary: string;
      success: boolean;
      conclusions: string[];
      artifactCount: number;
    } | undefined;
    try {
      const childSummary = await storage.getChildSummary(childId);
      if (childSummary) {
        childSummaryData = {
          resultId: childSummary.resultId,
          summary: childSummary.summary,
          success: childSummary.success,
          conclusions: childSummary.conclusions,
          artifactCount: childSummary.artifactCount,
        };
      }
    } catch (err) {
      logger.error('Failed to get child summary', err instanceof Error ? err : undefined, { childId });
    }

    // 3. Add system notification to parent's UI output buffer
    const parent = this.state.getInstance(child.parentId);
    if (parent) {
      let resultContent = `**Child completed:** ${child.displayName} (\`${childId}\`)`;
      if (childSummaryData) {
        resultContent += `\n\n**Result:** ${childSummaryData.success ? 'Success' : 'Failed'}`;
        resultContent += `\n\n${childSummaryData.summary}`;
        if (childSummaryData.conclusions.length > 0) {
          resultContent += `\n\n**Key findings:**\n${childSummaryData.conclusions.map(c => `- ${c}`).join('\n')}`;
        }
      }

      const resultMessage: OutputMessage = {
        id: `child-result-${Date.now()}-${childId.slice(-6)}`,
        timestamp: Date.now(),
        type: 'system' as const,
        content: resultContent,
        metadata: { source: 'child-result', childId, exitCode }
      };
      this.communication.addToOutputBuffer(parent, resultMessage);
      this.publishOutput(child.parentId, resultMessage);
    }

    // 4. Clean up tasks in TaskManager
    taskManager.cleanupChildTasks(childId);

    // 5. Notify parent CLI with rich result data (not just "terminated")
    const resultData = childSummaryData
      ? {
          name: child.displayName,
          summary: childSummaryData.summary,
          success: childSummaryData.success,
          conclusions: childSummaryData.conclusions
        }
      : undefined;

    const { remainingChildren } = orchestration.notifyChildTerminated(
      child.parentId,
      childId,
      resultData
    );

    logger.info('Child exited, parent notified', { childId, exitCode, parentId: child.parentId, remainingChildren });
    const childFailed = childSummaryData?.success === false || exitCode !== 0;
    const diagnosticBundle = childFailed
      ? await buildChildDiagnosticBundle(child, this.getChildTimeoutReason(child)).catch((error: unknown) => {
          logger.warn('Failed to build child diagnostic bundle', {
            childId,
            parentId: child.parentId,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        })
      : undefined;
    emitPluginHook(childFailed ? 'orchestration.child.failed' : 'orchestration.child.completed', {
      parentId: child.parentId,
      childId,
      name: child.displayName,
      success: childSummaryData?.success,
      summary: childSummaryData?.summary,
      resultId: childSummaryData?.resultId,
      exitCode,
      diagnosticBundle,
      timestamp: Date.now(),
    });

    // 6. If all children are done, inject synthesis prompt to parent CLI
    if (remainingChildren === 0) {
      const completedIds = orchestration.getCompletedChildIds(child.parentId);
      const summaries = await Promise.all(
        completedIds.map(async (cId) => {
          try {
            const s = await storage.getChildSummary(cId);
            const inst = this.state.getInstance(cId);
            return {
              childId: cId,
              name: inst?.displayName || s?.childId || cId,
              summary: s?.summary || 'No summary available',
              success: s?.success ?? false,
              conclusions: s?.conclusions || []
            };
          } catch {
            return {
              childId: cId,
              name: cId,
              summary: 'Failed to retrieve summary',
              success: false,
              conclusions: []
            };
          }
        })
      );

      if (summaries.length > 0) {
        orchestration.notifyAllChildrenCompleted(child.parentId, summaries);
        logger.info('All children completed, synthesis prompt injected', { parentId: child.parentId, childCount: summaries.length });
      }

      // Clean up all completed child instances now that synthesis data is gathered
      for (const cId of completedIds) {
        try {
          await this.terminateInstance(cId, false);
        } catch (err) {
          logger.error('Failed to clean up completed child instance', err instanceof Error ? err : undefined, { childId: cId });
        }
      }
    } else {
      // Not all children done yet — clean up just this child
      try {
        await this.terminateInstance(childId, false);
      } catch (err) {
        logger.error('Failed to clean up child instance', err instanceof Error ? err : undefined, { childId });
      }
    }
  }

  private getChildTimeoutReason(child: Instance): string | undefined {
    const timeoutMessage = [...child.outputBuffer]
      .reverse()
      .find((message) => (
        message.metadata?.['source'] === 'child-startup-watchdog'
        && typeof message.content === 'string'
      ));
    return timeoutMessage?.content;
  }

  // ============================================
  // Cleanup
  // ============================================

  destroy(): void {
    getPauseCoordinator().removeListener('pause', this.handlePause);
    getTaskManager().stopTimeoutChecker();
    this.state.destroy();
    this.lifecycle.destroy();
    this.terminateAll();
  }
}

// InstanceManager is owned by the main process entry point (src/main/index.ts)
// and passed to downstream modules via dependency injection:
//   - SessionContinuityManager.setInstanceManager()
//   - CrossModelReviewService.setInstanceManager()
//   - ChannelMessageRouter.setInstanceManager()
//   - ResourceGovernor.start({ getInstanceManager })
//   - handleNodeFailover(nodeId, instanceManager)
//   - handleLateNodeReconnect(nodeId, instanceManager)
// There is intentionally no module-level accessor — a global singleton
// accessor was a footgun that could construct a second InstanceManager if
// startup ordering drifted.

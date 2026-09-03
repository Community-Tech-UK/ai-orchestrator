/**
 * Orchestration Handler - Executes orchestrator commands from Claude instances
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import {
  OrchestratorCommand,
  SpawnChildCommand,
  MessageChildCommand,
  TerminateChildCommand,
  GetChildOutputCommand,
  CallToolCommand,
  ReportTaskCompleteCommand,
  ReportProgressCommand,
  ReportErrorCommand,
  GetTaskStatusCommand,
  ConsensusQueryCommand,
  CreateAutomationCommand,
  RequestUserActionCommand,
  parseOrchestratorCommands,
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
  generateOrchestrationPrompt,
  detectsConsensusIntent,
  detectsSchedulingIntent,
  CONSENSUS_INTENT_REMINDER,
  SCHEDULING_INTENT_REMINDER,
  type OrchestratorNodeSummary
} from './orchestration-protocol';
import { getRemoteNodeRosterService } from '../remote-node/remote-node-roster-service';
import { getConsensusCoordinator } from './consensus-coordinator';
import type { ConsensusProviderSpec } from './consensus.types';
import {
  getSessionAdmissionService,
  type AdmissionOutcome,
} from '../session/session-admission-service';
import {
  injectConsensusResult,
  handleConsensusRedelivery,
  type ConsensusResultInjectionDeps,
} from './consensus-result-injection';
import { AutomationCreatePayloadSchema } from '@contracts/schemas/automation';
import { getToolRegistry } from '../tools/tool-registry';
import { getPermissionManager, type PermissionRequest } from '../security/permission-manager';
import type { RoutingDecision } from '../routing';
import type {
  ReportResultCommand,
  GetChildSummaryCommand,
  GetChildArtifactsCommand,
  GetChildSectionCommand,
} from '../../shared/types/child-result.types';
import { emitPluginHook } from '../plugins/hook-emitter';
import { evaluateOrchestrationCapability, inferRoleFromContext } from './role-capability-policy';
import { createAutomationWithScheduling } from '../automations/automation-create-service';
import { resolveNewAutomationModelSelection } from '../../shared/automations/new-automation-model-default';
import type {
  OrchestrationContext,
  UserActionRequest,
  ChildInfo,
  ChildTerminationResult,
  CompletedChildSummary,
} from './orchestration-handler.types';
import { isParentUnavailableSuppression, OrchestrationResponseDelivery } from './orchestration-response-delivery';
import { computeCommandSignature } from './orchestration-command-signature';
import {
  handleGetChildArtifacts,
  handleGetChildSection,
  handleGetChildSummary,
  handleGetTaskStatus,
  handleReportError,
  handleReportProgress,
  handleReportResult,
  handleReportTaskComplete,
  type OrchestrationChildOpsHost,
} from './orchestration-handler-child-ops';

export type {
  OrchestrationContext,
  UserActionRequest,
  OrchestrationEvents,
  ChildInfo,
  ChildTerminationResult,
  CompletedChildSummary,
} from './orchestration-handler.types';

const logger = getLogger('OrchestrationHandler');

export class OrchestrationHandler extends EventEmitter {
  private contexts = new Map<string, OrchestrationContext>();
  private pendingUserActions = new Map<string, UserActionRequest>();
  private userActionWaiters = new Map<string, (approved: boolean, selectedOption?: string) => void>();
  /** Tracks completed children per parent: parentId → Set<childId> */
  private completedChildrenIds = new Map<string, Set<string>>();
  /** Tracks active in-process consensus queries per instance. */
  private activeConsensusQueries = new Map<string, number>();
  /** Tracks consecutive failed children per parent for spawn-failure backoff */
  private consecutiveFailures = new Map<string, number>();
  private suppressedChildCompletions = new Map<string, Map<string, string>>();
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  /**
   * Streaming-safe buffer for orchestrator command parsing.
   *
   * Claude/Gemini/Codex CLIs often stream assistant output in multiple chunks; the
   * `:::ORCHESTRATOR_COMMAND:::` marker block can be split across output events.
   * If we only parse per-chunk, we'd miss commands and the UI would never show
   * the requested user-action prompt.
   */
  private commandParseBuffers = new Map<string, string>();

  /**
   * Rate limiter: tracks recent command executions per instance to prevent feedback loops.
   * Key: instanceId, Value: array of { signature, timestamp }.
   */
  private recentCommands = new Map<string, { signature: string; timestamp: number }[]>();
  private static readonly COMMAND_DEDUP_WINDOW_MS = 30_000;
  private static readonly MAX_COMMANDS_PER_WINDOW = 10;
  private readonly responseDelivery: OrchestrationResponseDelivery;
  constructor() {
    super();
    this.responseDelivery = new OrchestrationResponseDelivery({
      emit: (instanceId, response) => this.emit('inject-response', instanceId, response),
      onChildCompletionRedelivered: (parentId, childId) => this.forgetSuppressedChildCompletion(parentId, childId),
    });
    // Refire a suppressed consensus_query result injection once the
    // requesting instance is ready again (see injectConsensusResult).
    getSessionAdmissionService().registerRedeliveryHandler(
      'consensus',
      (ctx) => handleConsensusRedelivery(this.consensusResultInjectionDeps(), ctx),
    );
  }

  /** Capabilities the extracted consensus-result-injection module needs from this handler. */
  private consensusResultInjectionDeps(): ConsensusResultInjectionDeps {
    return {
      injectResponse: (instanceId, action, success, data) =>
        this.injectResponse(instanceId, action, success, data, { alreadyAdmitted: true }),
    };
  }

  /**
   * Register an instance for orchestration
   */
  registerInstance(
    instanceId: string,
    workingDirectory: string,
    parentId: string | null = null
  ): void {
    this.contexts.set(instanceId, {
      instanceId,
      workingDirectory,
      parentId,
      childrenIds: []
    });
  }

  /**
   * Unregister an instance
   */
  unregisterInstance(instanceId: string): void {
    this.contexts.delete(instanceId);
    this.commandParseBuffers.delete(instanceId);
    this.recentCommands.delete(instanceId);
    this.consecutiveFailures.delete(instanceId);
    this.completedChildrenIds.delete(instanceId);
    this.activeConsensusQueries.delete(instanceId);
    this.suppressedChildCompletions.delete(instanceId);

    // Best-effort cleanup: drop any pending user actions for this instance.
    // Otherwise they can linger if an instance is terminated while awaiting input.
    for (const [requestId, request] of this.pendingUserActions.entries()) {
      if (request.instanceId === instanceId) {
        this.pendingUserActions.delete(requestId);
        this.userActionWaiters.delete(requestId);
      }
    }

    // Remove from parent's children list
    for (const ctx of this.contexts.values()) {
      ctx.childrenIds = ctx.childrenIds.filter((id) => id !== instanceId);
    }
  }

  /**
   * Add a child to a parent's context
   */
  addChild(parentId: string, childId: string): void {
    const ctx = this.contexts.get(parentId);
    if (ctx && !ctx.childrenIds.includes(childId)) {
      ctx.childrenIds.push(childId);
    }
  }

  /**
   * Reconcile a parent's tracked children after a replay-fallback restart
   * (gap C): a restart never runs the termination path, so children that died
   * while the parent was down stay in `childrenIds` as zombies. Drops children
   * the caller reports dead (moving them to the completed set so post-hoc
   * summary queries keep working) and keeps live ones.
   *
   * @returns kept/dropped child ids, or null when the parent has no
   * orchestration context.
   */
  reconcileChildrenAfterRestart(
    parentId: string,
    isChildAlive: (childId: string) => boolean,
  ): { kept: string[]; dropped: string[] } | null {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return null;

    const kept: string[] = [];
    const dropped: string[] = [];
    for (const childId of ctx.childrenIds) {
      (isChildAlive(childId) ? kept : dropped).push(childId);
    }

    // Include reaped children whose completion could not reach the parent.
    const suppressed = this.suppressedChildCompletions.get(parentId);
    if (suppressed) {
      for (const [childId, admissionId] of suppressed) {
        if (!dropped.includes(childId)) dropped.push(childId);
        getSessionAdmissionService().markFailed(
          admissionId,
          'Child completion represented by fresh-fallback degradation notice',
        );
      }
      this.suppressedChildCompletions.delete(parentId);
    }

    if (dropped.length > 0) {
      ctx.childrenIds = kept;
      if (!this.completedChildrenIds.has(parentId)) {
        this.completedChildrenIds.set(parentId, new Set());
      }
      const completed = this.completedChildrenIds.get(parentId)!;
      for (const childId of dropped) {
        completed.add(childId);
      }
      logger.info('Reconciled orchestration children after restart', {
        parentId,
        kept,
        dropped,
      });
    }

    return { kept, dropped };
  }

  /**
   * Check if a child belongs to a parent (active OR completed)
   */
  isChildOfParent(parentId: string, childId: string): boolean {
    const ctx = this.contexts.get(parentId);
    if (ctx && ctx.childrenIds.includes(childId)) return true;
    const completed = this.completedChildrenIds.get(parentId);
    return completed?.has(childId) ?? false;
  }

  /**
   * Get completed child IDs for a parent
   */
  getCompletedChildIds(parentId: string): string[] {
    const completed = this.completedChildrenIds.get(parentId);
    return completed ? Array.from(completed) : [];
  }

  /**
   * Get active consensus query count for an instance.
   */
  getActiveConsensusQueryCount(instanceId: string): number {
    return this.activeConsensusQueries.get(instanceId) ?? 0;
  }

  /**
   * Whether orchestration is currently performing work for this instance.
   */
  hasActiveWork(instanceId: string): boolean {
    const ctx = this.contexts.get(instanceId);
    return Boolean(
      (ctx && ctx.childrenIds.length > 0) ||
      this.getActiveConsensusQueryCount(instanceId) > 0
    );
  }

  private beginConsensusQuery(instanceId: string): number {
    const next = this.getActiveConsensusQueryCount(instanceId) + 1;
    this.activeConsensusQueries.set(instanceId, next);
    return next;
  }

  private endConsensusQuery(instanceId: string): number {
    const next = Math.max(0, this.getActiveConsensusQueryCount(instanceId) - 1);
    if (next === 0) {
      this.activeConsensusQueries.delete(instanceId);
    } else {
      this.activeConsensusQueries.set(instanceId, next);
    }
    return next;
  }

  /**
   * Get the orchestration prompt to prepend to the first message
   */
  getOrchestrationPrompt(instanceId: string, currentModel?: string): string {
    const connectedNodes: OrchestratorNodeSummary[] = getRemoteNodeRosterService()
      .list()
      .filter((node) => node.status === 'connected')
      .map((n) => ({
        id: n.id,
        name: n.name,
        platform: n.platform,
        cpuCores: n.capabilities.cpuCores,
        totalMemoryMB: n.capabilities.totalMemoryMB,
        gpuName: n.gpuName,
        supportedClis: n.supportedClis,
        hasBrowserRuntime: n.hasBrowserRuntime,
        hasDocker: n.hasDocker,
        activeInstances: n.activeInstances,
        maxConcurrentInstances: n.maxConcurrentInstances,
      }));
    return generateOrchestrationPrompt(instanceId, currentModel, connectedNodes);
  }

  /**
   * Re-surfaces relevant orchestration guidance after the first conversation turn.
   * Multiple matching reminders are returned in a stable order.
   */
  getLaterTurnReminderIfRelevant(message: string): string | null {
    const reminders: string[] = [];
    if (detectsSchedulingIntent(message)) {
      reminders.push(SCHEDULING_INTENT_REMINDER);
    }
    if (detectsConsensusIntent(message)) {
      reminders.push(CONSENSUS_INTENT_REMINDER);
    }
    return reminders.length > 0 ? reminders.join('\n\n') : null;
  }

  /**
   * Process output from an instance and execute any orchestrator commands
   */
  processOutput(instanceId: string, output: string): void {
    const start = ORCHESTRATION_MARKER_START;
    const end = ORCHESTRATION_MARKER_END;

    let buffer = (this.commandParseBuffers.get(instanceId) || '') + output;

    // Hard cap to avoid unbounded growth if an instance streams lots of text without markers.
    // Keep the tail because a marker might begin near the end of a chunk.
    const HARD_CAP = 200_000;
    if (buffer.length > HARD_CAP) {
      buffer = buffer.slice(buffer.length - HARD_CAP);
    }

    while (true) {
      const startIdx = buffer.indexOf(start);
      if (startIdx === -1) {
        // Keep only the tail that could still contain the beginning of a split marker.
        const keep = Math.max(0, start.length - 1);
        buffer = keep > 0 ? buffer.slice(-keep) : '';
        break;
      }

      const endIdx = buffer.indexOf(end, startIdx + start.length);
      if (endIdx === -1) {
        // We have a start marker but no end marker yet; keep from the start marker onward.
        buffer = buffer.slice(startIdx);
        break;
      }

      const jsonStr = buffer.slice(startIdx + start.length, endIdx).trim();
      // Use the validated parser to avoid executing malformed commands.
      const parsedCommands = parseOrchestratorCommands(`${start}\n${jsonStr}\n${end}`);
      if (parsedCommands.length === 0) {
        logger.warn('Failed to parse orchestrator command (streaming): invalid command shape');
      } else {
        for (const cmd of parsedCommands) this.executeCommand(instanceId, cmd);
      }

      // Drop everything through the end marker and continue scanning for more.
      buffer = buffer.slice(endIdx + end.length);
    }

    this.commandParseBuffers.set(instanceId, buffer);
  }

  /**
   * Execute an orchestrator command (with rate limiting and dedup)
   */
  private executeCommand(
    instanceId: string,
    command: OrchestratorCommand
  ): void {
    const ctx = this.contexts.get(instanceId);
    if (!ctx) {
      logger.warn('No orchestration context for instance', { instanceId });
      return;
    }

    const capability = evaluateOrchestrationCapability(inferRoleFromContext(ctx.parentId), command);
    if (!capability.allowed) {
      this.injectResponse(instanceId, command.action, false, {
        error: capability.reason,
        role: capability.profile.role,
      });
      return;
    }

    // Rate limiting: prevent feedback loops from runaway command execution.
    // Read-only commands (get_children, get_task_status, etc.) are exempt.
    const isReadOnly = ['get_children', 'get_task_status', 'get_child_output', 'get_child_summary', 'get_child_artifacts', 'get_child_section'].includes(command.action);
    if (!isReadOnly) {
      const now = Date.now();
      const signature = computeCommandSignature(command);
      const recent = this.recentCommands.get(instanceId) || [];

      // Prune expired entries
      const active = recent.filter(
        (entry) => now - entry.timestamp < OrchestrationHandler.COMMAND_DEDUP_WINDOW_MS
      );

      // Check for duplicate command within the dedup window
      if (active.some((entry) => entry.signature === signature)) {
        logger.warn('Duplicate command suppressed (dedup)', { action: command.action, instanceId, signature });
        return;
      }

      // Check global rate limit per instance
      if (active.length >= OrchestrationHandler.MAX_COMMANDS_PER_WINDOW) {
        logger.warn('Command rate limit exceeded', { action: command.action, instanceId, count: active.length });
        this.injectResponse(instanceId, command.action, false, {
          error: `Rate limit exceeded: ${active.length} commands in the last ${OrchestrationHandler.COMMAND_DEDUP_WINDOW_MS / 1000}s. Wait before issuing more commands.`,
        });
        return;
      }

      active.push({ signature, timestamp: now });
      this.recentCommands.set(instanceId, active);
    }

    logger.info('Executing orchestrator command', { action: command.action, instanceId });
    emitPluginHook('orchestration.command.received', {
      instanceId,
      action: command.action,
      command: { ...(command as unknown as Record<string, unknown>) },
      timestamp: Date.now(),
    });

    switch (command.action) {
      case 'spawn_child':
        this.handleSpawnChild(instanceId, command);
        break;

      case 'message_child':
        this.handleMessageChild(instanceId, command);
        break;

      case 'get_children':
        this.handleGetChildren(instanceId);
        break;

      case 'terminate_child':
        this.handleTerminateChild(instanceId, command);
        break;

      case 'get_child_output':
        this.handleGetChildOutput(instanceId, command);
        break;

      case 'call_tool':
        this.handleCallTool(instanceId, command);
        break;

      case 'report_task_complete':
        this.handleReportTaskComplete(instanceId, command);
        break;

      case 'report_progress':
        this.handleReportProgress(instanceId, command);
        break;

      case 'report_error':
        this.handleReportError(instanceId, command);
        break;

      case 'get_task_status':
        this.handleGetTaskStatus(instanceId, command);
        break;

      case 'request_user_action':
        this.handleRequestUserAction(instanceId, command);
        break;

      case 'create_automation':
        this.handleCreateAutomation(instanceId, command);
        break;

      // New structured result commands
      case 'report_result':
        this.handleReportResult(instanceId, command);
        break;

      case 'get_child_summary':
        this.handleGetChildSummary(instanceId, command);
        break;

      case 'get_child_artifacts':
        this.handleGetChildArtifacts(instanceId, command);
        break;

      case 'get_child_section':
        this.handleGetChildSection(instanceId, command);
        break;

      case 'consensus_query':
        this.handleConsensusQuery(instanceId, command);
        break;
    }
  }

  private childOpsHost(): OrchestrationChildOpsHost {
    return {
      getContext: (instanceId) => this.contexts.get(instanceId),
      isChildOfParent: (parentId, childId) => this.isChildOfParent(parentId, childId),
      injectResponse: (instanceId, action, success, data, options) =>
        this.injectResponse(instanceId, action, success, data, options),
      emit: (event, ...args) => this.emit(event, ...args),
    };
  }

  private handleSpawnChild(parentId: string, command: SpawnChildCommand): void {
    // Block spawning if too many consecutive children have failed (prevents runaway loops)
    const failures = this.consecutiveFailures.get(parentId) ?? 0;
    if (failures >= OrchestrationHandler.MAX_CONSECUTIVE_FAILURES) {
      logger.warn('Spawn blocked: too many consecutive child failures', { parentId, consecutiveFailures: failures });
      this.injectResponse(parentId, 'spawn_child', false, {
        error: `Spawn blocked: ${failures} consecutive child failures. Investigate why children are failing before spawning more. Use get_child_summary to review failure details.`,
      });
      return;
    }

    this.emit('spawn-child', parentId, command);
  }

  private getInstanceDepth(instanceId: string): number {
    // Best-effort: compute depth by walking parent pointers within the orchestration contexts.
    let depth = 0;
    let current = this.contexts.get(instanceId);
    while (current?.parentId) {
      depth += 1;
      current = this.contexts.get(current.parentId);
      if (depth > 50) break; // Prevent cycles / corrupted state.
    }
    return depth;
  }

  private async requestUserDecision(params: {
    instanceId: string;
    title: string;
    message: string;
    options: { id: string; label: string; description?: string }[];
    context?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ selectedOption?: string }> {
    const requestId = `uar-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const request: UserActionRequest = {
      id: requestId,
      instanceId: params.instanceId,
      requestType: 'select_option',
      title: params.title,
      message: params.message,
      options: params.options,
      context: params.context,
      createdAt: Date.now(),
    };

    this.pendingUserActions.set(requestId, request);
    this.emit('user-action-request', request);

    const timeoutMs = params.timeoutMs ?? 5 * 60 * 1000;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.userActionWaiters.delete(requestId);
        // Remove request from pending list if it still exists.
        this.pendingUserActions.delete(requestId);
        resolve({ selectedOption: undefined });
      }, timeoutMs);

      this.userActionWaiters.set(requestId, (_approved, selectedOption) => {
        clearTimeout(timer);
        resolve({ selectedOption });
      });
    });
  }

  private handleMessageChild(
    parentId: string,
    command: MessageChildCommand
  ): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'message_child', false, {
        error: `Child ${command.childId} not found or not owned by you`
      });
      return;
    }

    this.emit('message-child', parentId, command);
  }

  private handleGetChildren(parentId: string): void {
    this.emit('get-children', parentId, (children: ChildInfo[]) => {
      this.injectResponse(parentId, 'get_children', true, {
        children,
        completedChildIds: this.getCompletedChildIds(parentId),
        activeConsensusQueries: this.getActiveConsensusQueryCount(parentId),
      });
    });
  }

  private handleTerminateChild(
    parentId: string,
    command: TerminateChildCommand
  ): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'terminate_child', false, {
        error: `Child ${command.childId} not found or not owned by you`
      });
      return;
    }

    this.emit('terminate-child', parentId, command);
  }

  private handleGetChildOutput(
    parentId: string,
    command: GetChildOutputCommand
  ): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent. Include childId in the error
    // payload so the renderer can display "for child <id>" instead of "undefined".
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'get_child_output', false, {
        childId: command.childId,
        error: `Child ${command.childId} not found or not owned by you`
      });
      return;
    }

    this.emit('get-child-output', parentId, command, (output: string[]) => {
      this.injectResponse(parentId, 'get_child_output', true, {
        childId: command.childId,
        output
      });
    });
  }

  /**
   * Execute a local orchestrator tool and inject the result back into the instance.
   */
  private async handleCallTool(instanceId: string, command: CallToolCommand): Promise<void> {
    const ctx = this.contexts.get(instanceId);
    if (!ctx) return;

    try {
      const permissionManager = getPermissionManager();
      const permissionRequest: PermissionRequest = {
        id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        instanceId,
        scope: 'tool_use',
        resource: command.toolId,
        context: {
          toolName: command.toolId,
          workingDirectory: ctx.workingDirectory,
          isChildInstance: Boolean(ctx.parentId),
          depth: this.getInstanceDepth(instanceId),
          yoloMode: false, // Best-effort: CLI YOLO is separate from tool permission system today.
        },
        timestamp: Date.now(),
      };

      const decision = permissionManager.checkPermission(permissionRequest);
      if (decision.action === 'deny') {
        this.injectResponse(instanceId, 'call_tool', false, {
          toolId: command.toolId,
          error: `Permission denied for tool "${command.toolId}"`,
          reason: decision.reason,
        });
        return;
      }

      if (decision.action === 'ask') {
        const toolLabel = command.toolId;
        const toolArgsPreview = command.args ? JSON.stringify(command.args).slice(0, 500) : '';
        const message = [
          `Allow running local tool "${toolLabel}"?`,
          toolArgsPreview ? `Args: ${toolArgsPreview}` : undefined,
          `Working directory: ${ctx.workingDirectory}`,
        ].filter(Boolean).join('\n');

        const options = [
          { id: 'allow_once', label: 'Allow once (Recommended)', description: 'Run this tool a single time.' },
          { id: 'allow_session', label: 'Allow for session', description: 'Auto-allow this tool for this instance/session.' },
          { id: 'allow_always', label: 'Always allow', description: 'Auto-allow this tool in the future (non-persistent today).' },
          { id: 'deny_once', label: 'Deny once', description: 'Do not run this tool this time.' },
          { id: 'deny_session', label: 'Deny for session', description: 'Auto-deny this tool for this instance/session.' },
          { id: 'deny_always', label: 'Always deny', description: 'Auto-deny this tool in the future (non-persistent today).' },
        ];

        const { selectedOption } = await this.requestUserDecision({
          instanceId,
          title: 'Tool Permission Required',
          message,
          options,
          context: {
            suppressInjectResponse: true,
            permission: {
              scope: permissionRequest.scope,
              resource: permissionRequest.resource,
            },
          },
        });

        if (!selectedOption) {
          this.injectResponse(instanceId, 'call_tool', false, {
            toolId: command.toolId,
            error: `Permission request timed out for tool "${command.toolId}"`,
          });
          return;
        }

        const isAllow = selectedOption.startsWith('allow_');
        const scope = selectedOption.endsWith('_always')
          ? 'always'
          : selectedOption.endsWith('_session')
            ? 'session'
            : 'once';

        permissionManager.recordUserDecision(
          instanceId,
          permissionRequest,
          isAllow ? 'allow' : 'deny',
          scope
        );

        if (!isAllow) {
          this.injectResponse(instanceId, 'call_tool', false, {
            toolId: command.toolId,
            error: `Permission denied for tool "${command.toolId}"`,
            scope,
          });
          return;
        }
      }

      const registry = getToolRegistry();
      const result = await registry.callTool({
        toolId: command.toolId,
        args: command.args,
        ctx: { instanceId, workingDirectory: ctx.workingDirectory },
      });

      this.injectResponse(instanceId, 'call_tool', result.ok, {
        toolId: command.toolId,
        ...result,
      });
    } catch (error) {
      this.injectResponse(instanceId, 'call_tool', false, {
        toolId: command.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleReportTaskComplete(
    childId: string,
    command: ReportTaskCompleteCommand,
  ): void {
    handleReportTaskComplete(this.childOpsHost(), childId, command);
  }

  private handleReportProgress(
    childId: string,
    command: ReportProgressCommand,
  ): void {
    handleReportProgress(this.childOpsHost(), childId, command);
  }

  private handleReportError(
    childId: string,
    command: ReportErrorCommand,
  ): void {
    handleReportError(this.childOpsHost(), childId, command);
  }

  private handleGetTaskStatus(
    instanceId: string,
    command: GetTaskStatusCommand,
  ): void {
    handleGetTaskStatus(this.childOpsHost(), instanceId, command);
  }

  private async handleCreateAutomation(
    instanceId: string,
    command: CreateAutomationCommand
  ): Promise<void> {
    const ctx = this.contexts.get(instanceId);
    if (!ctx) return;

    try {
      const modelSelection = resolveNewAutomationModelSelection(command.automation.action);
      const payload = {
        ...command.automation,
        action: {
          ...command.automation.action,
          ...modelSelection,
          workingDirectory: command.automation.action.workingDirectory?.trim() || ctx.workingDirectory,
        },
      };
      const parsed = AutomationCreatePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        this.injectResponse(instanceId, 'create_automation', false, {
          error: 'Invalid automation payload',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        return;
      }

      const automation = await createAutomationWithScheduling(parsed.data);
      if (!automation) {
        this.injectResponse(instanceId, 'create_automation', false, {
          error: 'Automation was not created',
        });
        return;
      }

      this.injectResponse(instanceId, 'create_automation', true, {
        automationId: automation.id,
        automation,
        message: `Saved automation "${automation.name}".`,
      });
    } catch (error) {
      this.injectResponse(instanceId, 'create_automation', false, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle user action request from Claude
   */
  private handleRequestUserAction(
    instanceId: string,
    command: RequestUserActionCommand
  ): void {
    const requestId = `uar-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const request: UserActionRequest = {
      id: requestId,
      instanceId,
      requestType: command.requestType,
      title: command.title,
      message: command.message,
      targetMode: command.targetMode,
      options: command.options,
      questions: command.questions,
      context: command.context,
      createdAt: Date.now()
    };

    // Store the pending request
    this.pendingUserActions.set(requestId, request);

    // Emit event for UI to display the request
    this.emit('user-action-request', request);

    // Do NOT inject a "pending" acknowledgment here. Leaving the CLI waiting for
    // input keeps the LLM blocked until the user actually responds. The real
    // response is injected by respondToUserAction() once the user answers.

    logger.info('User action request created', { requestId, instanceId });
  }

  /**
   * Respond to a pending user action request
   */
  respondToUserAction(
    requestId: string,
    approved: boolean,
    selectedOption?: string
  ): void {
    const request = this.pendingUserActions.get(requestId);
    if (!request) {
      logger.warn('No pending user action request found', { requestId });
      return;
    }

    // Resolve any internal waiter first (tool permission gating, etc.).
    const waiter = this.userActionWaiters.get(requestId);
    if (waiter) {
      this.userActionWaiters.delete(requestId);
      try {
        waiter(approved, selectedOption);
      } catch {
        /* intentionally ignored: waiter callback errors should not block the response flow */
      }
    }

    // Remove from pending
    this.pendingUserActions.delete(requestId);

    const suppressInject = Boolean(request.context && (request.context as Record<string, unknown>)['suppressInjectResponse']);
    if (!suppressInject) {
      // Send response back to the instance
      this.injectResponse(request.instanceId, 'user_action_response', true, {
        requestId,
        approved,
        selectedOption,
        requestType: request.requestType,
        targetMode: request.targetMode
      });
    }

    logger.info('User action responded', { requestId, approved });
  }

  /**
   * Get all pending user action requests
   */
  getPendingUserActions(): UserActionRequest[] {
    return Array.from(this.pendingUserActions.values());
  }

  /**
   * Get pending user actions for a specific instance
   */
  getPendingUserActionsForInstance(instanceId: string): UserActionRequest[] {
    return Array.from(this.pendingUserActions.values()).filter(
      (r) => r.instanceId === instanceId
    );
  }

  /**
   * Send a response back to the instance
   */
  private injectResponse(
    instanceId: string,
    action: string,
    success: boolean,
    data: unknown,
    options: { alreadyAdmitted?: boolean } = {},
  ): AdmissionOutcome | null {
    return this.responseDelivery.inject(instanceId, action, success, data, options);
  }

  private forgetSuppressedChildCompletion(parentId: string, childId: string): void {
    const children = this.suppressedChildCompletions.get(parentId);
    if (!children) return;
    children.delete(childId);
    if (children.size === 0) this.suppressedChildCompletions.delete(parentId);
  }

  /**
   * Notify parent about a successful child spawn
   */
  notifyChildSpawned(
    parentId: string,
    childId: string,
    childName: string,
    routing?: RoutingDecision
  ): void {
    this.addChild(parentId, childId);

    // Build response data with optional routing info
    const responseData: Record<string, unknown> = {
      childId,
      name: childName,
      message: 'Child instance created successfully'
    };

    // Include routing information if available
    if (routing) {
      responseData['routing'] = {
        model: routing.model,
        complexity: routing.complexity,
        tier: routing.tier,
        confidence: routing.confidence,
        estimatedSavingsPercent: routing.estimatedSavingsPercent
      };
    }

    this.injectResponse(parentId, 'spawn_child', true, responseData);
  }

  /**
   * Notify parent about a successful message delivery
   */
  notifyMessageSent(parentId: string, childId: string): void {
    this.injectResponse(parentId, 'message_child', true, {
      childId,
      message: 'Message delivered successfully'
    });
  }

  /**
   * Notify parent about a child termination.
   * Moves the child from active to completed set and injects result data
   * into the parent CLI so the parent Claude can see what the child found.
   * Returns the number of remaining active children.
   */
  notifyChildTerminated(
    parentId: string,
    childId: string,
    resultData?: { name: string; summary: string; success: boolean; conclusions: string[] }
  ): ChildTerminationResult {
    const ctx = this.contexts.get(parentId);
    if (ctx) {
      ctx.childrenIds = ctx.childrenIds.filter((id) => id !== childId);
    }

    // Move to completed set so queries still work after termination
    if (!this.completedChildrenIds.has(parentId)) {
      this.completedChildrenIds.set(parentId, new Set());
    }
    this.completedChildrenIds.get(parentId)!.add(childId);

    // Track consecutive failures for spawn-loop backoff
    if (resultData && !resultData.success) {
      const prev = this.consecutiveFailures.get(parentId) ?? 0;
      this.consecutiveFailures.set(parentId, prev + 1);
    } else if (resultData?.success) {
      // Reset on success — the parent's strategy is working
      this.consecutiveFailures.set(parentId, 0);
    }

    // Inject rich result data (not just "terminated") so parent Claude sees findings
    const responseData: Record<string, unknown> = {
      childId,
      message: resultData
        ? `Child "${resultData.name}" completed: ${resultData.summary}`
        : 'Child instance terminated'
    };
    if (resultData) {
      responseData['name'] = resultData.name;
      responseData['summary'] = resultData.summary;
      responseData['success'] = resultData.success;
      responseData['conclusions'] = resultData.conclusions;
    }

    const injection = this.injectResponse(parentId, 'child_completed', true, responseData);
    if (injection?.kind === 'suppressed' && isParentUnavailableSuppression(injection.reason)) {
      let children = this.suppressedChildCompletions.get(parentId);
      if (!children) {
        children = new Map<string, string>();
        this.suppressedChildCompletions.set(parentId, children);
      }
      children.set(childId, injection.admissionId);
    }

    const remainingChildren = ctx ? ctx.childrenIds.length : 0;
    return { remainingChildren };
  }

  /**
   * Notify parent that ALL children have completed, injecting a synthesis
   * prompt so the parent Claude creates a comprehensive report.
   */
  notifyAllChildrenCompleted(
    parentId: string,
    childSummaries: CompletedChildSummary[]
  ): void {
    const summaryLines = childSummaries.map((cs) => {
      const statusLabel = cs.success ? 'SUCCESS' : 'FAILED';
      const conclusionLines = cs.conclusions.length > 0
        ? cs.conclusions.map(c => `    - ${c}`).join('\n')
        : '    (no conclusions reported)';
      return `  [${statusLabel}] ${cs.name} (${cs.childId}):\n    Summary: ${cs.summary}\n    Conclusions:\n${conclusionLines}`;
    });

    const synthesisPrompt = [
      `All ${childSummaries.length} child instances have completed.`,
      '',
      'Results:',
      ...summaryLines,
      '',
      'Please synthesize these results into a comprehensive report for the user.',
      'Highlight key findings, any failures, and recommended next steps.'
    ].join('\n');

    this.injectResponse(parentId, 'all_children_completed', true, {
      totalChildren: childSummaries.length,
      summaries: childSummaries,
      message: synthesisPrompt
    });
  }

  /**
   * Notify parent about a fast-path local retrieval result
   */
  notifyFastPathResult(
    parentId: string,
    payload: {
      summary: string;
      task: string;
      mode: 'grep' | 'files' | 'indexed-codebase';
      command: string;
      args: string[];
      totalMatches: number;
      lines: string[];
      cwd: string;
    }
  ): void {
    this.injectResponse(parentId, 'task_complete', true, {
      childId: 'fast-path',
      result: {
        summary: payload.summary,
        data: {
          task: payload.task,
          mode: payload.mode,
          command: payload.command,
          args: payload.args,
          totalMatches: payload.totalMatches,
          lines: payload.lines,
          cwd: payload.cwd
        }
      },
      message: payload.summary
    });
  }

  /**
   * Notify an instance about an error
   */
  notifyError(instanceId: string, error: string): void {
    this.injectResponse(instanceId, 'error', false, {
      error,
      message: error
    });
  }

  // ============================================
  // Multi-Model Consensus Handler
  // ============================================

  /**
   * Handle consensus_query command from an instance.
   * Fans out the question to multiple providers and injects the consensus result.
   */
  private async handleConsensusQuery(
    instanceId: string,
    command: ConsensusQueryCommand
  ): Promise<void> {
    const ctx = this.contexts.get(instanceId);
    if (!ctx) return;

    let consensusQueryActive = true;
    const finishConsensusQuery = (): void => {
      if (!consensusQueryActive) return;
      consensusQueryActive = false;
      this.endConsensusQuery(instanceId);
    };

    // Acknowledge the query immediately
    const activeConsensusQueries = this.beginConsensusQuery(instanceId);
    this.injectResponse(instanceId, 'consensus_query', true, {
      status: 'dispatching',
      activeConsensusQueries,
      providersRequested: command.providers ?? [],
      message: `Consensus query started. Consulting ${command.providers?.length || 'all available'} providers...`
    });
    emitPluginHook('orchestration.consensus.started', {
      instanceId,
      question: command.question,
      providers: command.providers,
      strategy: command.strategy,
      timestamp: Date.now(),
    });

    try {
      const coordinator = getConsensusCoordinator();

      // Map requested providers to ConsensusProviderSpec
      const providers: ConsensusProviderSpec[] | undefined = command.providers?.map(p => ({
        provider: p,
      }));

      const result = await coordinator.query(
        command.question,
        command.context,
        {
          providers,
          strategy: command.strategy,
          timeout: command.timeout,
          workingDirectory: ctx.workingDirectory,
        }
      );

      // Inject a concise result to avoid context bloat.
      // The consensus field already contains the formatted synthesis.
      const providerSummary = result.responses
        .map(r => `${r.provider}${r.model ? `/${r.model}` : ''}: ${r.success ? 'ok' : `failed: ${r.error}`} (${r.durationMs}ms)`)
        .join(', ');

      // Success only when at least one provider produced a usable response.
      // Previously we hardcoded `true` here, which reported SUCCESS to the
      // requesting instance even when every provider failed — deeply confusing
      // because `result.consensus` was then just "All providers failed".
      const anyProviderSucceeded = result.successCount > 0;
      const message = anyProviderSucceeded
        ? result.consensus
        : `Consensus query failed: all ${result.failureCount} provider(s) errored. ${providerSummary}`;

      finishConsensusQuery();
      if (anyProviderSucceeded) {
        emitPluginHook('orchestration.consensus.completed', {
          instanceId,
          successCount: result.successCount,
          failureCount: result.failureCount,
          totalDurationMs: result.totalDurationMs,
          timestamp: Date.now(),
        });
      } else {
        emitPluginHook('orchestration.consensus.failed', {
          instanceId,
          error: message,
          timestamp: Date.now(),
        });
      }
      injectConsensusResult(this.consensusResultInjectionDeps(), instanceId, anyProviderSucceeded, {
        status: anyProviderSucceeded ? 'complete' : 'failed',
        message,
        agreement: result.agreement,
        providers: providerSummary,
        successCount: result.successCount,
        failureCount: result.failureCount,
        totalDurationMs: result.totalDurationMs,
        activeConsensusQueries: this.getActiveConsensusQueryCount(instanceId),
        dissent: result.dissent.length > 0 ? result.dissent : undefined,
        edgeCases: result.edgeCases.length > 0 ? result.edgeCases : undefined,
        // Surface per-provider error reasons so the parent can see WHY each
        // provider failed rather than a generic "All providers failed".
        errors: anyProviderSucceeded
          ? undefined
          : result.responses
              .filter(r => !r.success)
              .map(r => ({
                provider: r.provider,
                model: r.model,
                error: r.error || 'unknown error',
                durationMs: r.durationMs,
              })),
      });
    } catch (error) {
      finishConsensusQuery();
      emitPluginHook('orchestration.consensus.failed', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      injectConsensusResult(this.consensusResultInjectionDeps(), instanceId, false, {
        status: 'failed',
        activeConsensusQueries: this.getActiveConsensusQueryCount(instanceId),
        error: error instanceof Error ? error.message : String(error),
        message: `Consensus query failed: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      finishConsensusQuery();
    }
  }

  // ============================================
  // Structured Result Handlers
  // ============================================

  private handleReportResult(childId: string, command: ReportResultCommand): void {
    handleReportResult(this.childOpsHost(), childId, command);
  }

  private handleGetChildSummary(
    parentId: string,
    command: GetChildSummaryCommand,
  ): void {
    handleGetChildSummary(this.childOpsHost(), parentId, command);
  }

  private handleGetChildArtifacts(
    parentId: string,
    command: GetChildArtifactsCommand,
  ): void {
    handleGetChildArtifacts(this.childOpsHost(), parentId, command);
  }

  private handleGetChildSection(
    parentId: string,
    command: GetChildSectionCommand,
  ): void {
    handleGetChildSection(this.childOpsHost(), parentId, command);
  }
}

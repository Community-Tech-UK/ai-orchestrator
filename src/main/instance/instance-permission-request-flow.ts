import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { getPermissionEnforcer } from '../security/permission-enforcer';
import { areAgentSecretCardRequestsAllowed } from '../secrets/secret-card-policy';
import { type PermissionRequest, type PermissionScope } from '../security/permission-manager';
import {
  loadOptionalProjectRules,
  mapCliPermissionActionToScope,
  normalizeRequestedPath,
  toPermissionGateMetadata,
} from './instance-permissions-facade';
import { maybeAdjudicateDeferredPermission, resetAdjudicatorBreaker } from '../security/approval-adjudicator';
import { getToolExecutionGate, type ToolExecutionGateDecision } from '../security/tool-execution-gate';
import type { InstanceContextPort } from './instance-context-port';

const logger = getLogger('InstanceManager');

export interface InstancePermissionRequestHost {
  getInstance(id: string): Instance | undefined;
  sendInputResponse(instanceId: string, response: string, permissionKey?: string): Promise<void>;
  resumeAfterDeferredPermission(instanceId: string, approved: boolean): Promise<void>;
  addToOutputBuffer(instance: Instance, msg: OutputMessage): void;
  publishOutput(instanceId: string, message: OutputMessage): void;
  emit(event: string, payload: unknown): boolean;
  getContext(): InstanceContextPort;
}

export interface InputRequiredPayload {
  instanceId: string;
  requestId: string;
  prompt: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Input-required permission gating for InstanceManager.
 * Pending-request bookkeeping, auto-allow/deny, and lifecycle events live here;
 * the manager remains the EventEmitter / send-resume host.
 */
const SECRET_REQUESTS_DISABLED_REASON =
  'workspace secret requests are turned off in Settings.';

export class InstancePermissionRequestFlow {
  private readonly pendingByInputId = new Map<string, PermissionRequest>();

  constructor(private readonly host: InstancePermissionRequestHost) {}

  async handleInputRequired(payload: InputRequiredPayload): Promise<void> {
    const instance = this.host.getInstance(payload.instanceId);
    const workingDirectory = instance?.workingDirectory || process.cwd();

    loadOptionalProjectRules(workingDirectory);

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
      metadataType: metaType,
    });

    // Operator switches for the workspace secret card. `workspaceSecretsEnabled`
    // is the master switch and `workspaceSecretsAllowAgentRequests` bars agents
    // from raising the card; both are documented as operator-only. Refuse here,
    // in main, so the card never reaches the renderer, and answer the agent so
    // it is not left waiting on a prompt nobody will see.
    if (metaType === 'secret_required' && !areAgentSecretCardRequestsAllowed()) {
      logger.info('[APPROVAL_TRACE] manager_block_secret_request', {
        approvalTraceId,
        instanceId: payload.instanceId,
        requestId: payload.requestId,
      });
      this.emitPermissionLifecycleEvent({
        instanceId: payload.instanceId,
        requestId: payload.requestId,
        outcome: 'deny',
        toolName: 'workspace-secret',
        reason: SECRET_REQUESTS_DISABLED_REASON,
        source: 'operator-setting',
        metadataType: metaType,
      });
      try {
        await this.host.sendInputResponse(
          payload.instanceId,
          `Secret request refused: ${SECRET_REQUESTS_DISABLED_REASON} Continue without it, or ask the user to supply the value another way.`,
        );
      } catch {
        /* intentionally ignored: auto-response send failure is non-critical */
      }
      if (instance) {
        const msg = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'system' as const,
          content: `Blocked a secret request from this session: ${SECRET_REQUESTS_DISABLED_REASON}`,
          metadata: { secretRequestBlocked: true },
        };
        this.host.addToOutputBuffer(instance, msg);
        this.host.publishOutput(payload.instanceId, msg);
      }
      return;
    }

    // Only gate the known CLI permission denial prompts (Claude CLI emits these for tool_result denial).
    if (metaType === 'permission_denial') {
      const action = meta['action'] as string | undefined;
      const rawPath = meta['path'] as string | undefined;
      const permissionKey = meta['permissionKey'] as string | undefined;
      const toolName = typeof meta['tool_name'] === 'string'
        ? String(meta['tool_name'])
        : (action || 'claude-cli');

      const scope = mapCliPermissionActionToScope(action);
      const resource =
        scope.startsWith('file_') || scope.startsWith('directory_')
          ? normalizeRequestedPath(workingDirectory, rawPath)
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
          agentId: instance?.agentId,
        },
        timestamp: Date.now(),
      };

      this.pendingByInputId.set(`${payload.instanceId}:${payload.requestId}`, request);
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
          await this.host.sendInputResponse(
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
              ...toPermissionGateMetadata(decision),
            },
          };
          this.host.addToOutputBuffer(instance, msg);
          this.host.publishOutput(payload.instanceId, msg);
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
      // Use the FULL command (no truncation): the resource is the match key and
      // the pattern persisted by an "always" decision. Truncating to 200 chars
      // dropped the tail of long/compound commands, so an "always" rule for a
      // long command could never match the (re-built) resource on a later run.
      const resource = toolName === 'Bash' && toolInput?.['command']
        ? `bash:${String(toolInput['command'])}`
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
          agentId: instance?.agentId,
        },
        timestamp: Date.now(),
      };

      this.pendingByInputId.set(`${payload.instanceId}:${payload.requestId}`, request);
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
          await this.host.resumeAfterDeferredPermission(
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
              ...toPermissionGateMetadata(decision),
            },
          };
          this.host.addToOutputBuffer(instance, msg);
          this.host.publishOutput(payload.instanceId, msg);
        }

        return;
      }

      // WS-B3: opt-in adjudicator for unattended instances (see approval-adjudicator.ts).
      if (decision.action === 'ask') {
        const adjudicated = await maybeAdjudicateDeferredPermission({
          instanceId: payload.instanceId,
          request,
          toolName: toolName || 'unknown',
          contextPort: this.host.getContext(),
        });
        if (adjudicated) {
          this.emitPermissionLifecycleEvent({
            instanceId: payload.instanceId,
            requestId: payload.requestId,
            outcome: adjudicated.approved ? 'allow' : 'deny',
            toolName: toolName || 'unknown',
            reason: adjudicated.reason,
            source: 'adjudicator',
            metadataType: metaType,
          });
          try {
            await this.host.resumeAfterDeferredPermission(payload.instanceId, adjudicated.approved);
          } catch (err) {
            logger.error('Auto-resume after adjudicated permission failed', err instanceof Error ? err : undefined, { instanceId: payload.instanceId });
          }
          if (instance) {
            const msg = {
              id: generateId(),
              timestamp: Date.now(),
              type: 'system' as const,
              content: `Permission ${adjudicated.approved ? 'allowed' : 'denied'} by adjudicator (risk ${adjudicated.riskLevel}) for ${toolName}: ${adjudicated.reason}`,
              metadata: { permissionDecision: true, adjudicated: true, ...toPermissionGateMetadata(decision) },
            };
            this.host.addToOutputBuffer(instance, msg);
            this.host.publishOutput(payload.instanceId, msg);
          }
          return;
        }
      }
    }

    // Default behavior: forward to renderer and let the user decide.
    const forwardedPayload = {
      ...payload,
      metadata: {
        ...meta,
        toolGate: permissionGateDecision
          ? toPermissionGateMetadata(permissionGateDecision)
          : undefined,
        toolName: permissionGateToolName,
        approvalTraceId,
        traceStage: 'main:instance-manager:forwarded',
      },
    };
    this.host.emit('instance:input-required', forwardedPayload);
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
      requestId: payload.requestId,
    });
  }

  recordUserDecision(params: {
    instanceId: string;
    requestId: string;
    action: 'allow' | 'deny';
    scope: 'once' | 'session' | 'always';
  }): void {
    const key = `${params.instanceId}:${params.requestId}`;
    const req = this.pendingByInputId.get(key);
    if (!req) return;
    this.pendingByInputId.delete(key);
    // WS-B3: a live human decision breaks the adjudicator's denial streak.
    resetAdjudicatorBreaker(params.instanceId);
    try {
      getPermissionEnforcer().recordUserDecision(params.instanceId, req, params.action, params.scope);
    } catch {
      /* intentionally ignored: recording user decision failure is non-critical */
    }
  }

  clearPending(instanceId: string, requestId: string): void {
    this.pendingByInputId.delete(`${instanceId}:${requestId}`);
  }

  clearInstance(instanceId: string): void {
    const keyPrefix = `${instanceId}:`;
    for (const key of this.pendingByInputId.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.pendingByInputId.delete(key);
      }
    }
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
    this.host.emit('permission:lifecycle', {
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
}

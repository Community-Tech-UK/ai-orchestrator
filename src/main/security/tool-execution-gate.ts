import { getBashValidationPipeline } from './bash-validation';
import type { BashValidationResult } from './bash-validation';
import { getPermissionEnforcer } from './permission-enforcer';
import type { EnforcementResult } from './permission-enforcer';
import type { PermissionRequest } from './permission-manager';
import { getToolPermissionChecker } from './tool-permission-checker';
import type { ToolPermissionResult } from '../../shared/types/tool-permission.types';
import { getToolValidator } from './tool-validator';
import type { ToolValidationResult } from './tool-validator';
import { getActionCircuitBreaker } from './action-circuit-breaker';
import { getFilesystemPolicy } from './filesystem-policy';
import { getNetworkPolicy } from './network-policy';

export interface ToolExecutionGateInput {
  request: PermissionRequest;
  toolName: string;
  toolInput?: Record<string, unknown>;
}

export interface ToolExecutionGateDecision {
  action: 'allow' | 'deny' | 'ask';
  reason: string;
  source:
    | 'permission-rule'
    | 'tool-validator'
    | 'tool-checker'
    | 'bash-validation'
    | 'circuit-breaker'
    | 'filesystem-policy'
    | 'network-policy';
  permission: EnforcementResult;
  toolPermission?: ToolPermissionResult;
  validation?: ToolValidationResult;
  bashValidation?: BashValidationResult;
}

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function getBashCommand(toolInput?: Record<string, unknown>): string | null {
  const command = toolInput?.['command'];
  return typeof command === 'string' && command.trim().length > 0
    ? command
    : null;
}

function shouldTryChildReadOnlyAutoAllow(
  request: PermissionRequest,
  permission: EnforcementResult,
  bashValidation: BashValidationResult,
): boolean {
  return request.context?.isChildInstance === true
    && permission.action === 'ask'
    && permission.source === 'mode'
    && bashValidation.risk === 'safe';
}

export class ToolExecutionGate {
  evaluate(input: ToolExecutionGateInput): ToolExecutionGateDecision {
    const decision = this.decide(input);
    return this.applyCircuitBreaker(decision, input.request.instanceId);
  }

  /**
   * After the base decision, count approved actions against the circuit breaker.
   * When the breaker trips (N actions / $X since last check-in), an `allow` is
   * downgraded to `ask` so a human re-confirms. No-op when the breaker is
   * disabled (the default), so base behavior is unchanged.
   */
  private applyCircuitBreaker(
    decision: ToolExecutionGateDecision,
    instanceId: string,
  ): ToolExecutionGateDecision {
    if (decision.action !== 'allow') return decision;
    const breaker = getActionCircuitBreaker();
    if (!breaker.enabled) return decision;
    const trip = breaker.recordAction(instanceId);
    if (!trip.tripped) return decision;
    return {
      ...decision,
      action: 'ask',
      reason: trip.reason ?? 'Approval checkpoint reached',
      source: 'circuit-breaker',
    };
  }

  private decide(input: ToolExecutionGateInput): ToolExecutionGateDecision {
    const permission = getPermissionEnforcer().enforce(input.request);
    const validation = getToolValidator().validateInput(input.toolName, input.toolInput);
    if (!validation.valid) {
      return {
        action: 'deny',
        reason: validation.errors.join('; '),
        source: 'tool-validator',
        permission,
        validation,
      };
    }

    const filesystemDecision = this.evaluateFilesystemPolicy(input.request);
    if (filesystemDecision) {
      return {
        action: 'deny',
        reason: filesystemDecision.reason,
        source: 'filesystem-policy',
        permission,
        validation,
      };
    }

    const networkDecision = this.evaluateNetworkPolicy(input.request);
    if (networkDecision) {
      return {
        action: 'deny',
        reason: networkDecision.reason,
        source: 'network-policy',
        permission,
        validation,
      };
    }

    const toolPermission = getToolPermissionChecker().checkPermission(
      normalizeToolName(input.toolName),
      {
        instanceId: input.request.instanceId,
        workingDirectory: input.request.context?.workingDirectory ?? process.cwd(),
        provider: 'orchestrator',
        isAutomated: false,
        parentInstanceId: undefined,
      },
    );

    if (toolPermission.behavior === 'deny') {
      return {
        action: 'deny',
        reason: toolPermission.reason ?? `Tool ${input.toolName} is denied by policy`,
        source: 'tool-checker',
        permission,
        toolPermission,
        validation,
      };
    }

    const bashCommand = input.toolName === 'Bash'
      ? getBashCommand(input.toolInput)
      : null;
    if (bashCommand) {
      const bashPipeline = getBashValidationPipeline();
      const bashValidation = bashPipeline.validate(bashCommand, {
        mode: permission.mode,
        workspacePath: input.request.context?.workingDirectory ?? process.cwd(),
        instanceDepth: input.request.context?.depth ?? 0,
        yoloMode: Boolean(input.request.context?.yoloMode),
        instanceId: input.request.instanceId,
      });

      if (bashValidation.risk === 'blocked') {
        return {
          action: 'deny',
          reason: bashValidation.message ?? 'Blocked by bash validation',
          source: 'bash-validation',
          permission,
          toolPermission,
          validation,
          bashValidation,
        };
      }

      if (bashValidation.risk === 'warning' && permission.action === 'allow') {
        return {
          action: 'ask',
          reason: bashValidation.message ?? 'Bash command requires approval',
          source: 'bash-validation',
          permission,
          toolPermission,
          validation,
          bashValidation,
        };
      }

      if (shouldTryChildReadOnlyAutoAllow(input.request, permission, bashValidation)) {
        const readOnlyValidation = bashPipeline.validate(bashCommand, {
          mode: 'read_only',
          workspacePath: input.request.context?.workingDirectory ?? process.cwd(),
          instanceDepth: input.request.context?.depth ?? 0,
          yoloMode: Boolean(input.request.context?.yoloMode),
          instanceId: input.request.instanceId,
        });

        if (readOnlyValidation.risk === 'safe' && readOnlyValidation.intent === 'read_only') {
          return {
            action: 'allow',
            reason: 'Safe read-only Bash command auto-allowed for child instance',
            source: 'bash-validation',
            permission,
            toolPermission,
            validation,
            bashValidation: readOnlyValidation,
          };
        }
      }

      return {
        action: permission.action,
        reason: permission.reason,
        source: 'permission-rule',
        permission,
        toolPermission,
        validation,
        bashValidation,
      };
    }

    if (toolPermission.behavior === 'warn' && permission.action === 'allow') {
      return {
        action: 'ask',
        reason: toolPermission.warningMessage ?? toolPermission.reason ?? `Tool ${input.toolName} requires approval`,
        source: 'tool-checker',
        permission,
        toolPermission,
        validation,
      };
    }

    return {
      action: permission.action,
      reason: permission.reason,
      source: 'permission-rule',
      permission,
      toolPermission,
      validation,
    };
  }

  private evaluateFilesystemPolicy(request: PermissionRequest): { reason: string } | null {
    const policy = getFilesystemPolicy();
    switch (request.scope) {
      case 'file_read':
      case 'directory_read':
        return policy.canRead(request.resource)
          ? null
          : { reason: `Filesystem policy denied read access to ${request.resource}` };
      case 'file_write':
      case 'file_delete':
      case 'directory_create':
      case 'directory_delete':
        return policy.canWrite(request.resource)
          ? null
          : { reason: `Filesystem policy denied write access to ${request.resource}` };
      default:
        return null;
    }
  }

  private evaluateNetworkPolicy(request: PermissionRequest): { reason: string } | null {
    if (request.scope !== 'network_access') {
      return null;
    }
    const result = getNetworkPolicy().recordRequest(request.resource);
    return result.allowed ? null : { reason: result.reason };
  }
}

let toolExecutionGateSingleton: ToolExecutionGate | null = null;

export function getToolExecutionGate(): ToolExecutionGate {
  if (!toolExecutionGateSingleton) {
    toolExecutionGateSingleton = new ToolExecutionGate();
  }
  return toolExecutionGateSingleton;
}

export function _resetToolExecutionGateForTesting(): void {
  toolExecutionGateSingleton = null;
}

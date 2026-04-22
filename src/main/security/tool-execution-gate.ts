import { getBashValidationPipeline } from './bash-validation';
import type { BashValidationResult } from './bash-validation';
import { getPermissionEnforcer } from './permission-enforcer';
import type { EnforcementResult } from './permission-enforcer';
import type { PermissionRequest } from './permission-manager';
import { getToolPermissionChecker } from './tool-permission-checker';
import type { ToolPermissionResult } from '../../shared/types/tool-permission.types';
import { getToolValidator } from './tool-validator';
import type { ToolValidationResult } from './tool-validator';

export interface ToolExecutionGateInput {
  request: PermissionRequest;
  toolName: string;
  toolInput?: Record<string, unknown>;
}

export interface ToolExecutionGateDecision {
  action: 'allow' | 'deny' | 'ask';
  reason: string;
  source: 'permission-rule' | 'tool-validator' | 'tool-checker' | 'bash-validation';
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

export class ToolExecutionGate {
  evaluate(input: ToolExecutionGateInput): ToolExecutionGateDecision {
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
      const bashValidation = getBashValidationPipeline().validate(bashCommand, {
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

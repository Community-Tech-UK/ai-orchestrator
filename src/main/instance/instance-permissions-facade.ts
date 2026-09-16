import * as path from 'path';
import { getLogger } from '../logging/logger';
import { applySubagentPermissions } from '../orchestration/derive-subagent-permission';
import { getPermissionManager, type PermissionScope } from '../security/permission-manager';
import type { ToolExecutionGateDecision } from '../security/tool-execution-gate';

const logger = getLogger('InstancePermissions');

export function loadOptionalProjectRules(workingDirectory: string): void {
  try {
    getPermissionManager().loadProjectRules(workingDirectory);
  } catch (error) {
    logger.debug('Project permission rules unavailable', {
      workingDirectory,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function inheritSubagentPermissions(opts: {
  childId: string;
  parentId: string;
  parentPlanModeActive: boolean;
}): void {
  try {
    applySubagentPermissions(opts.childId, {
      parentInstanceId: opts.parentId,
      permissionManager: getPermissionManager(),
      parentPlanModeActive: opts.parentPlanModeActive,
    });
  } catch (error) {
    logger.warn('Failed to apply subagent permission inheritance', {
      childId: opts.childId,
      parentId: opts.parentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function mapCliPermissionActionToScope(action: string | undefined): PermissionScope {
  const a = (action || '').toLowerCase();
  if (a.includes('read')) return 'file_read';
  if (a.includes('write') || a.includes('edit') || a.includes('create')) return 'file_write';
  if (a.includes('delete') || a.includes('remove')) return 'file_delete';
  if (a.includes('list') || a === 'ls') return 'directory_read';
  return 'tool_use';
}

export function normalizeRequestedPath(workingDirectory: string, requested: string | undefined): string {
  const p = (requested || '').trim();
  if (!p) return requested || '';
  if (path.isAbsolute(p)) return p;
  if (p.startsWith('./') || p.includes('/') || p.includes('\\')) {
    return path.join(workingDirectory, p);
  }
  return p;
}

export function toPermissionGateMetadata(decision: ToolExecutionGateDecision): Record<string, unknown> {
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

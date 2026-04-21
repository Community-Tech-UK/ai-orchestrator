import { getPermissionManager } from './permission-manager';
import type {
  PermissionDecision,
  PermissionRequest,
} from './permission-manager';
import type { PermissionMode } from './bash-validation/types';

export interface EnforcementResult extends PermissionDecision {
  mode: PermissionMode;
  source: 'rule' | 'mode';
}

export class PermissionEnforcer {
  enforce(request: PermissionRequest): EnforcementResult {
    const decision = getPermissionManager().checkPermission(request);
    return {
      ...decision,
      mode: this.resolveMode(request),
      source: decision.matchedRule ? 'rule' : 'mode',
    };
  }

  recordUserDecision(
    sessionId: string,
    request: PermissionRequest,
    action: 'allow' | 'deny',
    scope: 'once' | 'session' | 'always',
  ): void {
    getPermissionManager().recordUserDecision(sessionId, request, action, scope);
  }

  private resolveMode(request: PermissionRequest): PermissionMode {
    if (request.context?.yoloMode) {
      return 'allow';
    }

    switch (request.scope) {
      case 'file_read':
      case 'directory_read':
        return 'read_only';
      case 'file_write':
      case 'directory_create':
      case 'bash_execute':
      case 'tool_use':
        return 'workspace_write';
      default:
        return 'prompt';
    }
  }
}

let enforcerSingleton: PermissionEnforcer | null = null;

export function getPermissionEnforcer(): PermissionEnforcer {
  if (!enforcerSingleton) {
    enforcerSingleton = new PermissionEnforcer();
  }
  return enforcerSingleton;
}

export function _resetPermissionEnforcerForTesting(): void {
  enforcerSingleton = null;
}

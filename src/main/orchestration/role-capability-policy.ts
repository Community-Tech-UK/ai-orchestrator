import type {
  OrchestrationRole,
  RoleCapabilityDecision,
  RoleCapabilityProfile,
} from '../../shared/types/permission-registry.types';
import type { OrchestratorCommand } from './orchestration-protocol';

export const ROLE_CAPABILITY_PROFILES: Record<OrchestrationRole, RoleCapabilityProfile> = {
  parent_orchestrator: {
    role: 'parent_orchestrator',
    canSpawnChildren: true,
    canRequestConsensus: true,
    canRequestUserAction: true,
    canReportResult: false,
    canMessageChildren: true,
    canTerminateChildren: true,
    canCallTools: true,
  },
  worker: {
    role: 'worker',
    canSpawnChildren: false,
    canRequestConsensus: false,
    canRequestUserAction: false,
    canReportResult: true,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
  },
  reviewer: {
    role: 'reviewer',
    canSpawnChildren: false,
    canRequestConsensus: true,
    canRequestUserAction: false,
    canReportResult: true,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
  },
  verifier: {
    role: 'verifier',
    canSpawnChildren: false,
    canRequestConsensus: false,
    canRequestUserAction: false,
    canReportResult: true,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
  },
  recovery_agent: {
    role: 'recovery_agent',
    canSpawnChildren: false,
    canRequestConsensus: false,
    canRequestUserAction: false,
    canReportResult: true,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
  },
  automation_runner: {
    role: 'automation_runner',
    canSpawnChildren: false,
    canRequestConsensus: false,
    canRequestUserAction: false,
    canReportResult: false,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
  },
};

export function evaluateOrchestrationCapability(
  role: OrchestrationRole,
  command: OrchestratorCommand,
): RoleCapabilityDecision {
  const profile = ROLE_CAPABILITY_PROFILES[role];
  const denied = (reason: string): RoleCapabilityDecision => ({ allowed: false, reason, profile });

  switch (command.action) {
    case 'spawn_child':
      return profile.canSpawnChildren ? { allowed: true, profile } : denied(`${role} cannot spawn child instances`);
    case 'consensus_query':
      return profile.canRequestConsensus ? { allowed: true, profile } : denied(`${role} cannot request consensus`);
    case 'request_user_action':
      return profile.canRequestUserAction ? { allowed: true, profile } : denied(`${role} cannot request user action`);
    case 'message_child':
      return profile.canMessageChildren ? { allowed: true, profile } : denied(`${role} cannot message child instances`);
    case 'terminate_child':
      return profile.canTerminateChildren ? { allowed: true, profile } : denied(`${role} cannot terminate child instances`);
    case 'call_tool':
      return profile.canCallTools ? { allowed: true, profile } : denied(`${role} cannot call tools`);
    case 'report_result':
      return profile.canReportResult ? { allowed: true, profile } : denied(`${role} cannot report child results`);
    default:
      return { allowed: true, profile };
  }
}

export function inferRoleFromContext(parentId: string | null): OrchestrationRole {
  return parentId ? 'worker' : 'parent_orchestrator';
}

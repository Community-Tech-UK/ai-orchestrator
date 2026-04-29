import type {
  OrchestrationRole,
  RoleCapabilityDecision,
  RoleCapabilityProfile,
  RoleToolCategory,
} from '../../shared/types/permission-registry.types';
import type { OrchestratorCommand } from './orchestration-protocol';

const ALL_PROVIDERS = ['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor'];
const ALL_MODELS = ['*'];
const ALL_TOOL_CATEGORIES: RoleToolCategory[] = [
  'read',
  'analysis',
  'command_execution',
  'filesystem_write',
  'network',
  'webhook',
  'unknown',
];

export const ROLE_CAPABILITY_PROFILES: Record<OrchestrationRole, RoleCapabilityProfile> = {
  parent_orchestrator: {
    role: 'parent_orchestrator',
    canSpawnChildren: true,
    canRequestConsensus: true,
    canRequestUserAction: true,
    canCreateAutomations: true,
    canReportResult: false,
    canMessageChildren: true,
    canTerminateChildren: true,
    canCallTools: true,
    providerAllowlist: ALL_PROVIDERS,
    modelAllowlist: ALL_MODELS,
    filesystemWrite: 'ask',
    commandCategories: ALL_TOOL_CATEGORIES,
    networkAccess: true,
    webhookAccess: true,
    canUseYoloMode: true,
  },
  worker: {
    role: 'worker',
    canSpawnChildren: false,
    canRequestConsensus: false,
    canRequestUserAction: false,
    canCreateAutomations: false,
    canReportResult: true,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
    providerAllowlist: ALL_PROVIDERS,
    modelAllowlist: ALL_MODELS,
    filesystemWrite: 'ask',
    commandCategories: ['read', 'analysis', 'filesystem_write'],
    networkAccess: false,
    webhookAccess: false,
    canUseYoloMode: false,
  },
  reviewer: {
    role: 'reviewer',
    canSpawnChildren: false,
    canRequestConsensus: true,
    canRequestUserAction: false,
    canCreateAutomations: false,
    canReportResult: true,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
    providerAllowlist: ALL_PROVIDERS.filter((provider) => provider !== 'auto'),
    modelAllowlist: ALL_MODELS,
    filesystemWrite: 'deny',
    commandCategories: ['read', 'analysis'],
    networkAccess: false,
    webhookAccess: false,
    canUseYoloMode: false,
  },
  verifier: {
    role: 'verifier',
    canSpawnChildren: false,
    canRequestConsensus: false,
    canRequestUserAction: false,
    canCreateAutomations: false,
    canReportResult: true,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
    providerAllowlist: ALL_PROVIDERS,
    modelAllowlist: ALL_MODELS,
    filesystemWrite: 'ask',
    commandCategories: ['read', 'analysis', 'command_execution', 'filesystem_write'],
    networkAccess: false,
    webhookAccess: false,
    canUseYoloMode: false,
  },
  recovery_agent: {
    role: 'recovery_agent',
    canSpawnChildren: false,
    canRequestConsensus: false,
    canRequestUserAction: false,
    canCreateAutomations: false,
    canReportResult: true,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
    providerAllowlist: ALL_PROVIDERS,
    modelAllowlist: ALL_MODELS,
    filesystemWrite: 'ask',
    commandCategories: ['read', 'analysis', 'command_execution', 'filesystem_write'],
    networkAccess: false,
    webhookAccess: false,
    canUseYoloMode: false,
  },
  automation_runner: {
    role: 'automation_runner',
    canSpawnChildren: false,
    canRequestConsensus: false,
    canRequestUserAction: false,
    canCreateAutomations: false,
    canReportResult: false,
    canMessageChildren: false,
    canTerminateChildren: false,
    canCallTools: true,
    providerAllowlist: ALL_PROVIDERS,
    modelAllowlist: ALL_MODELS,
    filesystemWrite: 'ask',
    commandCategories: ['read', 'analysis', 'command_execution', 'filesystem_write', 'network'],
    networkAccess: true,
    webhookAccess: false,
    canUseYoloMode: false,
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
      if (!profile.canSpawnChildren) {
        return denied(`${role} cannot spawn child instances`);
      }
      if (command.yoloMode === true && !profile.canUseYoloMode) {
        return denied(`${role} cannot spawn yolo child instances`);
      }
      if (!isAllowedValue(command.provider ?? 'auto', profile.providerAllowlist)) {
        return denied(`${role} cannot spawn provider "${command.provider}"`);
      }
      if (command.model && !isAllowedValue(command.model, profile.modelAllowlist)) {
        return denied(`${role} cannot spawn model "${command.model}"`);
      }
      return { allowed: true, profile };
    case 'consensus_query':
      if (!profile.canRequestConsensus) {
        return denied(`${role} cannot request consensus`);
      }
      for (const provider of command.providers ?? []) {
        if (!isAllowedValue(provider, profile.providerAllowlist)) {
          return denied(`${role} cannot request consensus provider "${provider}"`);
        }
      }
      return { allowed: true, profile };
    case 'request_user_action':
      return profile.canRequestUserAction ? { allowed: true, profile } : denied(`${role} cannot request user action`);
    case 'create_automation':
      return profile.canCreateAutomations ? { allowed: true, profile } : denied(`${role} cannot create automations`);
    case 'message_child':
      return profile.canMessageChildren ? { allowed: true, profile } : denied(`${role} cannot message child instances`);
    case 'terminate_child':
      return profile.canTerminateChildren ? { allowed: true, profile } : denied(`${role} cannot terminate child instances`);
    case 'call_tool': {
      if (!profile.canCallTools) {
        return denied(`${role} cannot call tools`);
      }
      const category = classifyToolCategory(command.toolId);
      if (!profile.commandCategories.includes(category)) {
        return { ...denied(`${role} cannot call ${category} tools`), category };
      }
      if (category === 'filesystem_write' && profile.filesystemWrite === 'deny') {
        return { ...denied(`${role} cannot write files through tools`), category };
      }
      if (category === 'network' && !profile.networkAccess) {
        return { ...denied(`${role} cannot call network tools`), category };
      }
      if (category === 'webhook' && !profile.webhookAccess) {
        return { ...denied(`${role} cannot call webhook tools`), category };
      }
      return { allowed: true, profile, category };
    }
    case 'report_task_complete':
    case 'report_progress':
    case 'report_error':
    case 'report_result':
      return profile.canReportResult ? { allowed: true, profile } : denied(`${role} cannot report child results`);
    default:
      return { allowed: true, profile };
  }
}

function isAllowedValue(value: string, allowlist: string[]): boolean {
  return allowlist.includes('*') || allowlist.includes(value);
}

export function classifyToolCategory(toolId: string): RoleToolCategory {
  const normalized = toolId.toLowerCase();
  if (normalized.includes('webhook')) {
    return 'webhook';
  }
  if (
    normalized.includes('http')
    || normalized.includes('fetch')
    || normalized.includes('network')
    || normalized.includes('browser')
    || normalized.includes('exa')
  ) {
    return 'network';
  }
  if (
    normalized.includes('write')
    || normalized.includes('edit')
    || normalized.includes('delete')
    || normalized.includes('remove')
    || normalized.includes('apply_patch')
    || normalized.includes('filesystem')
  ) {
    return 'filesystem_write';
  }
  if (
    normalized.includes('bash')
    || normalized.includes('shell')
    || normalized.includes('exec')
    || normalized.includes('command')
  ) {
    return 'command_execution';
  }
  if (
    normalized.includes('lsp')
    || normalized.includes('search')
    || normalized.includes('grep')
    || normalized.includes('read')
    || normalized.includes('file')
  ) {
    return 'read';
  }
  if (normalized.includes('analy') || normalized.includes('diagnostic')) {
    return 'analysis';
  }
  return 'unknown';
}

export function inferRoleFromContext(parentId: string | null): OrchestrationRole {
  return parentId ? 'worker' : 'parent_orchestrator';
}

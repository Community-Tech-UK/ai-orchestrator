import { BUILTIN_AGENTS, type AgentProfile, type AgentToolPermissions, type ToolPermission } from './types/agent.types';
import type { SideChatAuthorityPolicy } from './types/side-chat.types';

export interface SessionPostureInput {
  yoloMode?: boolean;
  hardened?: boolean;
  permissions: AgentToolPermissions | null;
  modeName?: string;
  nodeName?: string;
  computerUseEnabled?: boolean;
  computerUseMode?: string;
}

export const CAPABILITY_WORDS = {
  checking: 'Checking…',
  unavailable: (provider: string) => `Not available for ${provider}`,
  queued: (setting: string, value: string) => `${setting} → ${value} after this reply`,
  'off-in-settings': 'Off in Settings',
} as const;

export function postureFromInstance(instance: {
  agentId?: string; yoloMode?: boolean; hardened?: boolean; computerUseMode?: string;
  workerNodeId?: string; executionLocation?: { type: string; nodeId?: string };
}, agents: readonly AgentProfile[] = BUILTIN_AGENTS): SessionPostureInput {
  const id = instance.agentId ?? 'build';
  const agent = agents.find(candidate => candidate.id === id);
  return {
    yoloMode: instance.yoloMode, hardened: instance.hardened,
    permissions: agent?.permissions ?? null,
    modeName: agent?.name ?? id.charAt(0).toUpperCase() + id.slice(1),
    computerUseMode: instance.computerUseMode,
    nodeName: instance.executionLocation?.type === 'remote'
      ? instance.executionLocation.nodeId : undefined,
  };
}

export function describePostureSentence(input: SessionPostureInput): string {
  const parts = [input.yoloMode ? 'Acts without asking' : 'Asks before acting'];
  const permissions = input.permissions;
  if (!permissions) parts.push(`permissions set by the ${input.modeName ?? 'Custom'} mode`);
  else {
    parts.push(permissions.write === 'deny' ? 'read-only'
      : permissions.write === 'ask' ? 'asks before editing'
      : input.hardened ? 'edits only inside this folder' : 'can edit files');
    parts.push(permissions.web === 'allow' ? 'web allowed'
      : permissions.web === 'ask' ? 'asks before using the web' : 'no web');
  }
  if (input.nodeName) parts.push(`runs on ${input.nodeName}`);
  if (input.computerUseEnabled && input.computerUseMode) parts.push(`desktop control: ${input.computerUseMode}`);
  return parts.join(' · ');
}

const PERMISSION_WORDS: Record<ToolPermission, string> = {
  allow: 'allowed',
  ask: 'asks first',
  deny: 'blocked',
};

/**
 * Plain-language lines describing the permissions a sidechat inherits from its
 * parent session, for the "Permissions: same as parent" inspector.
 */
export function describePermissionPolicy(policy: SideChatAuthorityPolicy): string[] {
  const permissions = policy.agentToolPermissions;
  const lines = [
    `Reading files: ${PERMISSION_WORDS[permissions.read]}`,
    `Editing files: ${PERMISSION_WORDS[permissions.write]}`,
    `Shell commands: ${PERMISSION_WORDS[permissions.bash]}`,
    `Web access: ${PERMISSION_WORDS[permissions.web]}`,
    `Subagents: ${PERMISSION_WORDS[permissions.task]}`,
    policy.yoloMode ? 'Approvals: actions run without asking' : 'Approvals: asks before acting',
  ];
  if (policy.hardened) lines.push('Sandbox: runs inside the macOS sandbox');
  if (policy.containedExecution) lines.push('Environment: filtered, no inherited secrets');
  if (policy.browserToolsMode === 'off') lines.push('Browser tools: off');
  if (policy.computerUseMode) lines.push(`Computer Use: ${policy.computerUseMode}`);
  if (policy.workspaceNode) lines.push(`Runs on worker: ${policy.workspaceNode}`);
  return lines;
}

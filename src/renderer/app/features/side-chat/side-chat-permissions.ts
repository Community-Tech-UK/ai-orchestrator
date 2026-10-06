import type { ToolPermission } from '../../../../shared/types/agent.types';
import type { SideChatAuthorityPolicy } from '../../../../shared/types/side-chat.types';

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

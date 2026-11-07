import { resolveClaudeAllowRuleTool } from '../../../../shared/permissions/claude-allow-rule-tools';
import { friendlyToolName } from '../../../../shared/permissions/friendly-tool-name';
import { PERMISSION_SCOPE_WORDS } from '../../../../shared/permissions/permission-scope-presentation';
export type InputRequiredScope = 'once' | 'session' | 'always';

export interface InputRequiredRequestLike {
  instanceId: string;
  requestType: string;
  permissionMetadata?: {
    type?: string;
    tool_name?: string;
    /** Set by the live "Allow once" broker, whose once is strictly this one call. */
    live?: boolean;
    path?: string;
  };
}

export function isPermissionDenialRequest(
  request: InputRequiredRequestLike,
): boolean {
  return request.requestType === 'input_required'
    && request.permissionMetadata?.type === 'permission_denial';
}

export function shouldClearInputRequiredForYolo(
  request: InputRequiredRequestLike,
): boolean {
  return request.requestType === 'input_required'
    && !isPermissionDenialRequest(request)
    && !['ask_user_question', 'acp_elicitation'].includes(request.permissionMetadata?.type ?? '');
}

export function shouldClearRequestAfterYoloEnabled(
  request: InputRequiredRequestLike,
  instanceId: string,
): boolean {
  return request.instanceId === instanceId
    && shouldClearInputRequiredForYolo(request);
}

export function canResolveInputRequiredWithYolo(
  request: InputRequiredRequestLike,
): boolean {
  return shouldClearInputRequiredForYolo(request);
}

export function defaultInputRequiredScope(
  metadata: InputRequiredRequestLike['permissionMetadata'] | undefined,
): InputRequiredScope {
  return metadata?.type === 'permission_denial' ? 'always' : 'once';
}

export type PermissionMetadata = InputRequiredRequestLike['permissionMetadata'];
export type PermissionAskKind = 'claude-denial' | 'claude-held' | 'single';

export function permissionAskKind(meta: PermissionMetadata): PermissionAskKind {
  if (meta?.type === 'permission_denial') return 'claude-denial';
  return meta?.type === 'deferred_permission' ? 'claude-held' : 'single';
}

export function canAddClaudeAllowRule(meta: PermissionMetadata): boolean {
  return resolveClaudeAllowRuleTool(meta?.tool_name) !== undefined;
}

export function permissionScopesFor(meta: PermissionMetadata): InputRequiredScope[] {
  switch (permissionAskKind(meta)) {
    case 'claude-denial': return canAddClaudeAllowRule(meta) ? ['always'] : [];
    case 'claude-held': return ['once', 'session', 'always'];
    case 'single': return ['once'];
  }
}

/** A command ask keeps the command wording; any other tool is named so "this session" cannot be read as every tool. */
function namedTool(meta: PermissionMetadata): string | undefined {
  return meta?.tool_name === 'Bash' ? undefined : friendlyToolName(meta?.tool_name || 'this tool');
}

export function approveLabelFor(meta: PermissionMetadata, scope: InputRequiredScope): string | undefined {
  if (permissionAskKind(meta) === 'claude-denial') {
    return canAddClaudeAllowRule(meta) ? 'Always allow (adds a rule to ~/.claude/settings.json and restarts)' : undefined;
  }
  if (permissionAskKind(meta) === 'single' || scope === 'once') return PERMISSION_SCOPE_WORDS.once.allow;
  const tool = namedTool(meta);
  if (scope === 'session') return tool ? `Allow ${tool} for this session` : PERMISSION_SCOPE_WORDS.session.allow;
  return `${PERMISSION_SCOPE_WORDS.always.allow} ${tool ?? 'this command'}`;
}

export function rejectLabelFor(meta: PermissionMetadata, scope: InputRequiredScope): string {
  if (permissionAskKind(meta) === 'claude-denial') {
    return canAddClaudeAllowRule(meta) ? PERMISSION_SCOPE_WORDS.once.refuse : 'OK';
  }
  if (permissionAskKind(meta) === 'single' || scope === 'once') return PERMISSION_SCOPE_WORDS.once.refuse;
  const tool = namedTool(meta);
  if (scope === 'session') return tool ? `Block ${tool} for this session` : PERMISSION_SCOPE_WORDS.session.refuse;
  return `${PERMISSION_SCOPE_WORDS.always.refuse} ${tool ?? 'this command'}`;
}

export function decisionFor(meta: PermissionMetadata, approved: boolean, selected: InputRequiredScope):
  { action: 'allow' | 'deny'; scope?: InputRequiredScope } | undefined {
  const kind = permissionAskKind(meta);
  if (kind === 'claude-denial') {
    return approved && canAddClaudeAllowRule(meta) ? { action: 'allow', scope: 'always' } : undefined;
  }
  if (kind === 'claude-held' && !approved && selected === 'once') return { action: 'deny' };
  return { action: approved ? 'allow' : 'deny', scope: kind === 'single' ? 'once' : selected };
}

export function scopeOptionLabel(scope: InputRequiredScope): string {
  return PERMISSION_SCOPE_WORDS[scope].choice;
}

export function permissionHintFor(meta: PermissionMetadata, scope: InputRequiredScope): string {
  if (permissionAskKind(meta) === 'claude-denial') {
    const tool = meta?.tool_name || 'this tool';
    if (!canAddClaudeAllowRule(meta)) {
      return `Harness can't add an allow rule for ${tool}. To allow it, switch on Auto-approve with the YOLO button at the top of this session, then ask Claude to try again; or add a rule to ~/.claude/settings.json yourself.`;
    }
    return `Allows ${tool} on ${meta?.path || 'the requested resource'} in every Claude session. The session restarts, so ask Claude to try again once it reconnects.`;
  }
  if (permissionAskKind(meta) !== 'claude-held') return '';
  if (meta?.live) {
    if (scope === 'once') return 'Allows only this call.';
    return scope === 'always' ? 'Saved in Harness. Remove it under Settings > Permissions > Rules.' : 'Applies only in this session.';
  }
  if (scope === 'once') return 'Also allows the same command for the next hour.';
  return scope === 'always' ? 'Saved in Harness (~/.orchestrator/permissions.json) for this exact command, in every session.' : '';
}

/** A refusal can carry a typed reason except for a one-shot ask, whose only answers are the two buttons. */
export function canTellWhatToDoInstead(meta: PermissionMetadata): boolean {
  return permissionAskKind(meta) !== 'single';
}
